import process from "node:process";
import { closeDb } from "../db/client.js";
import { bindService, logger } from "../obs/logger.js";
import { runCycle } from "./engine.js";

/**
 * ora2-calibrator — daemon process for the calibrator (P2c MVP).
 *
 * Modes:
 *   --one-shot   — run a single cycle, log result, exit 0 (or 1 on error)
 *   default      — run forever, fire runCycle every CAL_INTERVAL_MS (1h)
 *
 * The daemon is purely advisory: it writes calibrator_recommendations rows
 * but never mutates strategy_filters. UI / operator decides whether to act.
 */

const ONE_SHOT = process.argv.includes("--one-shot");
const INTERVAL_MS = Number(process.env["CAL_INTERVAL_MS"] ?? 3_600_000);

async function tick(): Promise<void> {
  try {
    const r = await runCycle();
    logger.info(
      {
        cycleId: r.cycleId,
        recCount: r.recommendations.length,
        acceptedCount: r.acceptedCount,
        avgPnlPerTradeUsd: r.avgPnlPerTradeUsd,
      },
      "calibrator cycle done",
    );
  } catch (err) {
    logger.error({ err }, "calibrator cycle threw");
  }
}

async function main(): Promise<void> {
  bindService("ora2-calibrator");

  if (ONE_SHOT) {
    let exitCode = 0;
    try {
      const r = await runCycle();
      logger.info(
        {
          cycleId: r.cycleId,
          recCount: r.recommendations.length,
          acceptedCount: r.acceptedCount,
          avgPnlPerTradeUsd: r.avgPnlPerTradeUsd,
        },
        "one-shot complete",
      );
    } catch (err) {
      logger.error({ err }, "one-shot failed");
      exitCode = 1;
    } finally {
      await closeDb();
    }
    process.exit(exitCode);
  }

  logger.info({ intervalMs: INTERVAL_MS }, "calibrator daemon started");

  // First tick immediately so we get an initial snapshot without waiting an
  // hour. Subsequent ticks honour CAL_INTERVAL_MS.
  await tick();
  const handle = setInterval(() => {
    void tick();
  }, INTERVAL_MS);

  // Graceful shutdown — release the DB pool so the process exits cleanly.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "calibrator shutting down");
    clearInterval(handle);
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Keep the event loop alive (setInterval already does, but be explicit).
  await new Promise<void>(() => {});
}

void main();
