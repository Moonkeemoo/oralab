import process from "node:process";
import { closeDb } from "../db/client.js";
import { bindService, logger } from "../obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "../obs/tracer.js";
import { startRestServer } from "./rest_server.js";

/** ora2-api entry point — REST server for the Mini App (P2a). */

async function main(): Promise<void> {
  bindService("ora2-api");
  startTelemetry({ serviceName: "ora2-api" });
  process.env["ORA2_API_STARTED_AT"] = new Date().toISOString();
  const server = startRestServer();

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "ora2-api shutting down");
    await new Promise<void>((res) => server.close(() => res()));
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
