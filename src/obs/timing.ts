import { getDb } from "../db/client.js";
import { signalTimings } from "../db/schema.js";
import { logger } from "./logger.js";

export interface TimingCtx {
  signalId: number | null;
  positionId: number | null;
  chain: "entry" | "exit";
}

/**
 * Measure how long `fn` takes and append a row to signal_timings.
 * Fire-and-forget — DB errors logged + swallowed so a flaky log path
 * never blocks the trading hot path.
 */
export async function withTiming<T>(
  ctx: TimingCtx,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - start);
    void (async () => {
      try {
        const db = getDb();
        await db.insert(signalTimings).values({
          signalId: ctx.signalId,
          positionId: ctx.positionId,
          chain: ctx.chain,
          stage,
          durationMs: ms,
          ts: Date.now(),
        });
      } catch (err) {
        logger.debug({ err, stage }, "signal_timings insert failed");
      }
    })();
  }
}
