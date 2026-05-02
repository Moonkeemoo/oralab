import process from "node:process";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { closeDb } from "./db/client.js";
import { positions } from "./db/schema.js";
import { DryFillSimulator } from "./execute/dry_filler.js";
import { backfillFillsFromActivity } from "./execute/fill_backfill.js";
import { DbFillHandler } from "./execute/fill_handler.js";
import { fillReconcilerFromEnv } from "./execute/fill_reconciler.js";
import { PositionMonitor } from "./monitor/position_monitor.js";
import { bindService, logger } from "./obs/logger.js";
import { shutdownTelemetry, startTelemetry } from "./obs/tracer.js";

/**
 * ora2-trader entry point.
 *
 * Runs the exit-side loop: PositionMonitor at 2 Hz drives reconciler →
 * decide_exit → ExitExecutor for every active position. The entry side runs
 * in src/feed/main.ts as a separate process (ora2-feed), and the watchdog in
 * src/watchdog/main.ts (ora2-watchdog).
 *
 * FillReconciler subscribes to user WS in LIVE mode only — DRY mode posts
 * no orders so there are no own-fills to reconcile.
 *
 * In P1 solo, user_id=1 (Taras) is hardcoded. P3c multi-user makes this a
 * loop over active users.
 */

const SOLO_USER_ID = 1;

async function main(): Promise<void> {
  bindService("ora2-trader");
  startTelemetry({ serviceName: "ora2-trader" });

  const monitor = new PositionMonitor({ userId: SOLO_USER_ID });
  monitor.start();

  const dryFiller = new DryFillSimulator();
  dryFiller.start();

  let reconciler: ReturnType<typeof fillReconcilerFromEnv> | null = null;
  if ((process.env["DRY_RUN"] ?? "true").toLowerCase() !== "true") {
    try {
      const handler = new DbFillHandler();
      const marketsProvider = async (): Promise<readonly string[]> => {
        // Subscribe to every market we currently have skin in. Polymarket V2
        // user channel is silent for markets you don't list, so we re-derive
        // this list on every reconnect.
        const db = getDb();
        const rows = await db.query.positions.findMany({
          where: and(
            eq(positions.userId, SOLO_USER_ID),
            inArray(positions.status, ["PENDING", "FILLED", "OPEN", "EXITING"] as const),
          ),
          columns: { conditionId: true },
        });
        const set = new Set(rows.map((r) => r.conditionId));
        return Array.from(set);
      };
      reconciler = fillReconcilerFromEnv(handler, marketsProvider, async ({ walletAddress }) => {
        // On every WS open (initial + reconnect), backfill any missed fills
        // from /activity within last 24h.
        await backfillFillsFromActivity({ walletAddress, lookbackHours: 24 }, (event) =>
          handler.onFill(event),
        );
      });
      reconciler.start();
      logger.info("FillReconciler started (LIVE mode) with /activity backfill on connect");
    } catch (err) {
      logger.warn({ err }, "FillReconciler failed to init — continuing without it");
    }
  } else {
    logger.info("DRY_RUN — FillReconciler not started");
  }

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "trader shutting down");
    monitor.stop();
    reconciler?.stop();
    dryFiller.stop();
    await shutdownTelemetry();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
