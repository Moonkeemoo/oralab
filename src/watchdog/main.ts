import process from "node:process";
import { closeDb } from "../db/client.js";
import { logger } from "../obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "../obs/tracer.js";
import { WatchdogDaemon } from "./daemon.js";

async function main(): Promise<void> {
  startTelemetry();

  const daemon = new WatchdogDaemon();
  daemon.start();

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "watchdog shutting down");
    daemon.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
