import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { positions, wallets } from "../db/schema.js";
import { decideExit } from "../decide.js";
import { executeExitIntent } from "../execute/executor.js";
import { logger } from "../obs/logger.js";
import { decideExitDurationMs, positionMonitorTickMs } from "../obs/metrics.js";
import { withSpan } from "../obs/tracer.js";
import { DEFAULT_EXIT_CONFIG, type ExitConfig } from "../types/decide.js";
import type { PositionView } from "../types/position.js";
import { applyReconResult, type PositionForRecon, reconcileWalletPositions } from "./reconciler.js";
import { buildSnapshot } from "./snapshot.js";

/**
 * PositionMonitor — 2 Hz tick orchestrator.
 *
 *   for each user × strategy:
 *     fetch open/exiting/pending/filled positions from DB
 *     reconcile against /positions (chain truth)
 *     for each non-frozen position:
 *       buildSnapshot (gamma + book)
 *       decide_exit (pure)
 *       executeExitIntent (mutates if non-hold)
 *
 * Records position_monitor_tick_ms histogram per tick to track architecture
 * §06 SLO target (p99 ≤ 200ms).
 */

const TICK_INTERVAL_MS = 500;

const ACTIVE_STATUSES = ["PENDING", "FILLED", "OPEN", "EXITING"] as const;

interface MonitorOptions {
  readonly userId: number;
  readonly exitConfig?: ExitConfig;
}

export class PositionMonitor {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly cfg: ExitConfig;

  constructor(private readonly options: MonitorOptions) {
    this.cfg = options.exitConfig ?? DEFAULT_EXIT_CONFIG;
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      { userId: this.options.userId, intervalMs: TICK_INTERVAL_MS },
      "PositionMonitor started",
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info("PositionMonitor stopped");
  }

  /** Public for testing — drive a single tick deterministically. */
  async tick(): Promise<void> {
    if (this.inFlight) return; // skip if previous tick still running
    this.inFlight = true;
    const start = performance.now();
    try {
      await withSpan("position_monitor.tick", async () => {
        await this.processOnce();
      });
    } catch (err) {
      logger.error({ err }, "PositionMonitor tick failed");
    } finally {
      positionMonitorTickMs.record(performance.now() - start);
      this.inFlight = false;
    }
  }

  private async processOnce(): Promise<void> {
    const db = getDb();
    const userId = this.options.userId;

    const wallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
    if (!wallet) {
      logger.debug({ userId }, "no wallet for user; skipping tick");
      return;
    }

    const open = await db.query.positions.findMany({
      where: and(eq(positions.userId, userId), inArray(positions.status, [...ACTIVE_STATUSES])),
    });
    if (open.length === 0) return;

    const reconInput: PositionForRecon[] = open.map((p) => ({
      id: Number(p.id),
      walletAddress: wallet.address,
      assetId: p.assetId,
      status: p.status as PositionForRecon["status"],
      shares: Number(p.shares ?? 0),
      lastStateChangeTs: Number(p.lastStateChangeTs ?? Date.now()),
    }));

    const reconResults = await reconcileWalletPositions(wallet.address, reconInput);
    for (const { pos, result } of reconResults) {
      if (result.action !== "ok" && result.action !== "continue") {
        await applyReconResult(pos.id, result);
      }
    }

    const recIndex = new Map(reconResults.map((r) => [r.pos.id, r] as const));

    for (const dbPos of open) {
      const numericId = Number(dbPos.id);
      const rec = recIndex.get(numericId);
      // Skip positions reconciler took action on (close/freeze): next tick will see new status
      if (rec && (rec.result.action === "close" || rec.result.action === "freeze")) continue;

      const view: PositionView = {
        id: String(dbPos.id),
        userId: Number(dbPos.userId),
        walletAddress: wallet.address,
        conditionId: dbPos.conditionId,
        assetId: dbPos.assetId,
        side: (dbPos.side as "YES" | "NO") ?? "YES",
        status: dbPos.status as PositionView["status"],
        shares: Number(dbPos.shares ?? 0),
        onChainShares: rec?.result.chainSize ?? Number(dbPos.shares ?? 0),
        fillPrice: Number(dbPos.fillPrice ?? 0),
        peakPrice: Number(dbPos.peakPrice ?? 0),
        fillTs: Number(dbPos.fillTs ?? Date.now()),
        lastStateChangeTs: Number(dbPos.lastStateChangeTs ?? Date.now()),
        trailArmed: Boolean(dbPos.trailArmed),
        sweepCount: Number(dbPos.sweepCount ?? 0),
        reconciliationDriftPct: rec?.result.drift ?? 0,
      };

      let snap: Awaited<ReturnType<typeof buildSnapshot>>;
      try {
        snap = await buildSnapshot(view.conditionId, view.assetId, view.side);
      } catch (err) {
        logger.warn({ posId: numericId, err }, "snapshot fetch failed; skipping this position");
        continue;
      }

      const decideStart = performance.now();
      const intent = decideExit(view, snap, this.cfg);
      decideExitDurationMs.record(performance.now() - decideStart);

      if (intent.action === "hold") continue;

      try {
        const out = await executeExitIntent(view, snap, intent);
        if (!out.applied) {
          logger.debug({ posId: numericId, reason: out.skipReason }, "executor skipped");
        }
      } catch (err) {
        logger.error({ posId: numericId, err }, "executor threw");
      }
    }
  }
}
