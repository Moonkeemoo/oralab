import process from "node:process";
import { closeDb } from "../db/client.js";
import { bindService, logger } from "../obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "../obs/tracer.js";
import { RtdsFeed } from "./rtds_feed.js";
import { routeWhaleBuy } from "./signal_router.js";
import { matchWhale, refreshWhaleCache } from "./wallet_matcher.js";

/**
 * ora2-feed entry point.
 *
 *   1. start telemetry (no-op if OTEL endpoint unset)
 *   2. warm whale cache from DB
 *   3. connect RTDS WebSocket and route every tracked-whale BUY to SignalRouter
 *   4. SIGTERM/SIGINT → graceful stop
 *
 * RTDS replaces the earlier WhaleActivityPoller — push-based, sub-second
 * latency, no rate-limit concerns. Per v1 4-month proof.
 */

async function main(): Promise<void> {
  bindService("ora2-feed");
  startTelemetry({ serviceName: "ora2-feed" });
  await refreshWhaleCache();

  const feed = new RtdsFeed({
    handler: { onWhaleBuy: (addr, act) => routeWhaleBuy(addr, act) },
    isWhaleTracked: async (addr) => (await matchWhale(addr)) !== null,
  });
  feed.start();

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "feed shutting down");
    feed.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
