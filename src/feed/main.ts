import process from "node:process";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../db/client.js";
import { whales } from "../db/schema.js";
import { bindService, logger } from "../obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "../obs/tracer.js";
import { routeWhaleBuy } from "./signal_router.js";
import { refreshWhaleCache } from "./wallet_matcher.js";
import { WhaleActivityPoller } from "./whale_poller.js";

/**
 * ora2-feed entry point.
 *
 *   1. start telemetry (no-op if OTEL endpoint unset)
 *   2. load tracked whales from DB
 *   3. start WhaleActivityPoller, route each new BUY through SignalRouter
 *   4. SIGTERM/SIGINT → graceful stop
 */

async function loadTrackedWhaleAddresses(): Promise<string[]> {
  const db = getDb();
  const rows = await db.query.whales.findMany({ where: eq(whales.tracked, true) });
  return rows.map((r) => r.address.toLowerCase());
}

async function main(): Promise<void> {
  bindService("ora2-feed");
  startTelemetry({ serviceName: "ora2-feed" });
  await refreshWhaleCache();

  const whaleAddresses = await loadTrackedWhaleAddresses();
  if (whaleAddresses.length === 0) {
    logger.error("no tracked whales in DB — seed first via npm run db:seed");
    process.exitCode = 1;
    return;
  }

  logger.info({ count: whaleAddresses.length }, "starting whale poller");

  const poller = new WhaleActivityPoller({
    whaleAddresses,
    handler: {
      onWhaleBuy: (addr, act) => routeWhaleBuy(addr, act),
    },
  });
  poller.start();

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "feed shutting down");
    poller.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
