import process from "node:process";
import { getDb } from "../db/client.js";
import { decisions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import type { ExitIntent } from "../types/decide.js";
import type { MarketSnapshot } from "../types/market.js";
import type { PositionView } from "../types/position.js";

/**
 * P2b: persist every decide_exit call (snapshot + intent + gates + duration)
 * to the `decisions` table. P3a shadow-replay reads these rows to validate
 * a strategy change against captured production behavior — without these we
 * can't tell whether a code change "would have" exited at the right moment.
 *
 * Sampling: by default every call is logged. For high-volume markets set
 * DECISION_LOG_SAMPLE_PCT (0..1) to log a fraction of HOLD calls — non-HOLD
 * actions (sells, freezes, redeems) are always logged because they're rare
 * and high-signal.
 *
 * Failure mode: any DB error here is logged + swallowed. Trading decisions
 * never block on telemetry.
 */

const SAMPLE_PCT = (() => {
  const v = Number(process.env["DECISION_LOG_SAMPLE_PCT"] ?? 1);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
})();
const ENABLED = (process.env["DECISION_LOG_ENABLED"] ?? "true").toLowerCase() !== "false";

export interface DecisionLogInput {
  pos: PositionView;
  snap: MarketSnapshot;
  intent: ExitIntent;
  durationMs: number;
}

export async function recordDecision(input: DecisionLogInput): Promise<void> {
  if (!ENABLED) return;
  // Always log non-hold/non-trivial actions. Sample HOLDs.
  if (input.intent.action === "hold" && Math.random() > SAMPLE_PCT) return;

  try {
    const db = getDb();
    await db.insert(decisions).values({
      userId: input.pos.userId,
      positionId: Number(input.pos.id) || null,
      signalId: null,
      inputSnapshot: {
        // Snapshot subset that's load-bearing for replay; full raw kept
        // separately if needed via `raw` field on positions/orders.
        bid: input.snap.bid,
        ask: input.snap.ask,
        mark: input.snap.mark,
        markSource: input.snap.markSource,
        markTs: input.snap.markTs,
        tickSize: input.snap.tickSize,
        expectedOutcomeValue: input.snap.expectedOutcomeValue,
        acceptingOrders: input.snap.acceptingOrders,
        umaResolutionStatus: input.snap.umaResolutionStatus,
        resolved: input.snap.resolved,
        position: {
          status: input.pos.status,
          shares: input.pos.shares,
          onChainShares: input.pos.onChainShares,
          fillPrice: input.pos.fillPrice,
          peakPrice: input.pos.peakPrice,
          fillTs: input.pos.fillTs,
          sweepCount: input.pos.sweepCount,
          trailArmed: input.pos.trailArmed,
          reconciliationDriftPct: input.pos.reconciliationDriftPct,
        },
      },
      outputIntent: {
        action: input.intent.action,
        price: input.intent.price,
        size: input.intent.size,
        urgency: input.intent.urgency,
        reason: input.intent.reason,
        snapshotTs: input.intent.snapshotTs,
      },
      gates: [...input.intent.gates],
      durationMs: Math.round(input.durationMs),
      ts: Date.now(),
    });
  } catch (err) {
    // Don't let logging failures cascade — they're observability, not safety.
    logger.warn({ err, posId: input.pos.id }, "decision log insert failed");
  }
}
