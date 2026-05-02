import { and, eq, gte, lte } from "drizzle-orm";
import { type DataActivity, getActivity } from "../api/data.js";
import { getDb } from "../db/client.js";
import { fills, orders } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import type { UserTradeEvent } from "./fill_reconciler.js";

/**
 * Missed-fill backfill: on WS connect (initial + reconnect), scan
 * /activity for any of our recent fills that are NOT in our `fills`
 * table and don't have a matching position transition. Synthesize an
 * OwnFillEvent for each, call the handler.
 *
 * Defends against WS disconnect during a fill event (would otherwise
 * leave position EXITING/PENDING forever until reconciler grace expires
 * and FROZEN it).
 *
 * Mapping: /activity has (asset, side, timestamp, txHash) but no orderID.
 * We map back to our orders by (asset_id, side, time-window) — pick the
 * latest order with status NOT in {FILLED, FAILED, CANCELED}.
 */

interface BackfillCfg {
  walletAddress: string;
  lookbackHours: number;
}

export async function backfillFillsFromActivity(
  cfg: BackfillCfg,
  onFill: (event: UserTradeEvent) => Promise<void> | void,
): Promise<{ scanned: number; matched: number; emitted: number }> {
  const log = logger.child({ component: "fill_backfill" });
  const db = getDb();
  const sinceMs = Date.now() - cfg.lookbackHours * 60 * 60 * 1000;

  let scanned = 0;
  let matched = 0;
  let emitted = 0;

  let activity: DataActivity[];
  try {
    activity = await getActivity(cfg.walletAddress, { limit: 100, type: "TRADE" });
  } catch (err) {
    log.warn({ err }, "/activity fetch failed; backfill aborted");
    return { scanned: 0, matched: 0, emitted: 0 };
  }

  for (const a of activity) {
    if (a.timestamp * 1000 < sinceMs) continue;
    scanned += 1;
    const tx = a.transactionHash.toLowerCase();
    if (!tx) continue;

    // Already recorded?
    const exists = await db.query.fills.findFirst({ where: eq(fills.txHash, tx) });
    if (exists) continue;

    // Match this activity to one of our orders by (asset_id, side, ±5min window)
    const winLow = new Date(a.timestamp * 1000 - 5 * 60_000);
    const winHigh = new Date(a.timestamp * 1000 + 5 * 60_000);
    const candidate = await db.query.orders.findFirst({
      where: and(
        eq(orders.side, a.side),
        gte(orders.createdAt, winLow),
        lte(orders.createdAt, winHigh),
      ),
      orderBy: (cols, { desc }) => [desc(cols.createdAt)],
    });
    if (!candidate?.positionId) continue;
    matched += 1;

    const synthetic: UserTradeEvent = {
      event_type: "trade",
      type: "TRADE",
      id: tx,
      asset_id: a.asset,
      market: a.conditionId,
      side: a.side,
      size: String(a.size),
      price: String(a.price),
      status: "CONFIRMED",
      taker_order_id: candidate.clobOrderId ?? candidate.clientOrderId,
      transaction_hash: tx,
      matchtime: String(a.timestamp),
      timestamp: a.timestamp,
    };

    log.info(
      { tx, asset: a.asset, side: a.side, positionId: candidate.positionId },
      "backfill: emitting synthetic fill from /activity",
    );
    try {
      await onFill(synthetic);
      emitted += 1;
    } catch (err) {
      log.error({ err, tx }, "backfill onFill threw");
    }
  }

  log.info({ scanned, matched, emitted, lookbackHours: cfg.lookbackHours }, "backfill done");
  return { scanned, matched, emitted };
}
