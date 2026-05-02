import process from "node:process";
import { closeDb } from "../db/client.js";
import { bindService, logger } from "../obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "../obs/tracer.js";
import { RtdsFeed } from "./rtds_feed.js";
import { routeWhaleBuy } from "./signal_router.js";
import { sportsEventConsumerFromEnv } from "./sports_event_consumer.js";
import { SportsRouter } from "./sports_router.js";
import { matchWhale, refreshWhaleCache } from "./wallet_matcher.js";

const SOLO_USER_ID = 1;

/**
 * ora2-feed entry point.
 *
 *   1. start telemetry (no-op if OTEL endpoint unset)
 *   2. warm whale cache from DB
 *   3. connect RTDS WebSocket → route tracked-whale BUYs to SignalRouter
 *   4. connect Sports WS → SportsEventConsumer → SportsRouter (P1.5)
 *   5. SIGTERM/SIGINT → graceful stop
 *
 * RTDS replaces the earlier WhaleActivityPoller — push-based, sub-second
 * latency, no rate-limit concerns. Per v1 4-month proof.
 *
 * SportsEventConsumer subscribes to wss://sports-api.polymarket.com/ws
 * (no auth, auto-streams active games). SportsRouter currently logs
 * `game_ended` events for our active positions; future P1.5+ work will
 * fold this into a SportsWsReactorStrategy with proactive exit timing.
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

  const sportsRouter = new SportsRouter({ userId: SOLO_USER_ID });
  const sportsConsumer = sportsEventConsumerFromEnv((event) => sportsRouter.onScoreEvent(event));
  if ((process.env["SPORTS_WS_DISABLED"] ?? "false").toLowerCase() === "true") {
    logger.info("SPORTS_WS_DISABLED=true — SportsEventConsumer not started");
  } else {
    sportsConsumer.start();
    logger.info("SportsEventConsumer started (P1.5 game_ended → SportsRouter)");
  }

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "feed shutting down");
    feed.stop();
    sportsConsumer.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
