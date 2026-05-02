import { eq } from "drizzle-orm";
import { type DataPosition, getPositions } from "../api/data.js";
import { getDb } from "../db/client.js";
import { positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import { reconciliationDriftPct } from "../obs/metrics.js";

/**
 * INV-D3 reconciler — per-tick DB ↔ chain consistency check.
 *
 * Pseudocode source: docs/architecture.html §08.
 *
 * Outputs ReconResult per position; PositionMonitor consumes it to:
 *   - skip the tick (continue)
 *   - sync DB to chain (sync_to_chain)
 *   - close position with chain_lag reason (close)
 *   - mark FROZEN (freeze)
 *   - proceed normally (ok)
 *
 * Grace periods absorb 5–30s data-api eventual consistency window.
 */

export type ReconAction = "ok" | "continue" | "sync_to_chain" | "close" | "freeze";

export interface ReconResult {
  readonly action: ReconAction;
  readonly chainSize: number;
  readonly drift: number;
  readonly note?: string;
  readonly reason?: string;
}

export interface PositionForRecon {
  readonly id: number;
  readonly walletAddress: string;
  readonly assetId: string;
  readonly status:
    | "PENDING"
    | "FILLED"
    | "OPEN"
    | "EXITING"
    | "RESOLVED"
    | "CLOSED"
    | "FAILED"
    | "FROZEN";
  readonly shares: number;
  readonly lastStateChangeTs: number;
}

const DRIFT_OK = 0.005;
const DRIFT_SYNC = 0.05;
const DRIFT_FREEZE = 0.1;
const GRACE_PENDING_FILLED_MS = 30_000;
const GRACE_EXITING_MS = 60_000;

function pickFromChain(chain: readonly DataPosition[], assetId: string): DataPosition | undefined {
  return chain.find((p) => p.asset === assetId);
}

export function reconcileAgainstChain(
  pos: PositionForRecon,
  chain: readonly DataPosition[],
  nowMs: number,
): ReconResult {
  const chainPos = pickFromChain(chain, pos.assetId);
  const ageMs = nowMs - pos.lastStateChangeTs;

  // Case 1: chain has nothing for this asset
  if (!chainPos) {
    if (pos.status === "PENDING" && ageMs < GRACE_PENDING_FILLED_MS) {
      return { action: "continue", chainSize: 0, drift: 0, note: "PENDING grace" };
    }
    if (pos.status === "FILLED" && ageMs < GRACE_PENDING_FILLED_MS) {
      return { action: "continue", chainSize: 0, drift: 0, note: "FILLED grace" };
    }
    if (pos.status === "EXITING" && ageMs < GRACE_EXITING_MS) {
      return { action: "continue", chainSize: 0, drift: 0, note: "EXITING grace" };
    }
    if (pos.status === "EXITING") {
      return {
        action: "close",
        chainSize: 0,
        drift: 0,
        reason: "sell_filled_chain_lag",
      };
    }
    return {
      action: "freeze",
      chainSize: 0,
      drift: 0,
      reason: "chain_invisible",
    };
  }

  // Case 2: chain shows position; check size convergence
  const denom = pos.shares > 0 ? pos.shares : 1;
  const drift = Math.abs(chainPos.size - pos.shares) / denom;
  reconciliationDriftPct.record(drift, { user: "1" });

  if (drift < DRIFT_OK) {
    return { action: "ok", chainSize: chainPos.size, drift };
  }

  // Eventual consistency window for state changes
  if (ageMs < GRACE_PENDING_FILLED_MS) {
    return { action: "continue", chainSize: chainPos.size, drift, note: "grace_period" };
  }

  if (drift < DRIFT_SYNC) {
    logger.warn({ posId: pos.id, drift, chainSize: chainPos.size }, "minor drift — sync to chain");
    return { action: "sync_to_chain", chainSize: chainPos.size, drift };
  }
  if (drift < DRIFT_FREEZE) {
    logger.warn(
      { posId: pos.id, drift, chainSize: chainPos.size },
      "P1: meaningful drift — freeze",
    );
    return { action: "freeze", chainSize: chainPos.size, drift, reason: "drift_5_to_10" };
  }
  logger.error({ posId: pos.id, drift, chainSize: chainPos.size }, "P0: major drift — freeze");
  return { action: "freeze", chainSize: chainPos.size, drift, reason: "drift_over_10" };
}

/**
 * Apply a ReconResult to the DB. Single statement per position; caller
 * batches per tick. Returns updated `(onChainShares, reconciliationDriftPct)`
 * pair which decide_exit consumes.
 */
export async function applyReconResult(posId: number, result: ReconResult): Promise<void> {
  const db = getDb();
  switch (result.action) {
    case "ok":
    case "continue":
      // No mutation — DB already correct (or in grace).
      return;
    case "sync_to_chain":
      await db
        .update(positions)
        .set({
          shares: result.chainSize,
          lastStateChangeTs: Date.now(),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, posId));
      return;
    case "close":
      await db
        .update(positions)
        .set({
          status: "CLOSED",
          closeReason: result.reason ?? null,
          shares: result.chainSize,
          lastStateChangeTs: Date.now(),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, posId));
      return;
    case "freeze":
      await db
        .update(positions)
        .set({
          status: "FROZEN",
          closeReason: result.reason ?? null,
          lastStateChangeTs: Date.now(),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, posId));
      return;
  }
}

export async function reconcileWalletPositions(
  walletAddress: string,
  posList: readonly PositionForRecon[],
): Promise<readonly { pos: PositionForRecon; result: ReconResult }[]> {
  const chain = await getPositions(walletAddress);
  const now = Date.now();
  return posList.map((pos) => ({ pos, result: reconcileAgainstChain(pos, chain, now) }));
}
