import process from "node:process";
import { closeDb } from "./db/client.js";
import { PositionMonitor } from "./monitor/position_monitor.js";
import { logger } from "./obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "./obs/tracer.js";

/**
 * ora2-trader entry point.
 *
 * Runs the exit-side loop: PositionMonitor at 2 Hz drives reconciler →
 * decide_exit → ExitExecutor for every active position. The entry side runs
 * in src/feed/main.ts as a separate process (ora2-feed), and the watchdog in
 * src/watchdog/main.ts (ora2-watchdog).
 *
 * In P1 solo, user_id=1 (Taras) is hardcoded. P3c multi-user makes this a
 * loop over active users.
 */

const SOLO_USER_ID = 1;

async function main(): Promise<void> {
  startTelemetry();

  const monitor = new PositionMonitor({ userId: SOLO_USER_ID });
  monitor.start();

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "trader shutting down");
    monitor.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
