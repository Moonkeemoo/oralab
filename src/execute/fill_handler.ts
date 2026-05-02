import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fills, positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import type { FillHandler, UserOrderEvent, UserTradeEvent } from "./fill_reconciler.js";
import { findPositionIdByOrderId } from "./order_recorder.js";

/**
 * On-chain fill consumer. INV-M3 lives here: closure_reason is written
 * ONLY when /activity (or User WS) confirms our SELL filled, never on
 * placeSell-accept (QA-181).
 *
 *   OrderFilled BUY  → position PENDING/FILLED → OPEN; fills row inserted
 *   OrderFilled SELL → position EXITING → CLOSED with chain SELL tx hash
 *   OrderCanceled    → log only; reconciler/decide_exit handle the next tick
 *
 * Idempotent: duplicate WS events for same (txHash, positionId) UPSERT into
 * `fills` (unique constraint uq_fills_tx_hash_position) and the position
 * status update is a no-op if already in target state.
 */

export class DbFillHandler implements FillHandler {
  async onFill(event: UserTradeEvent): Promise<void> {
    // V2 user channel emits one TRADE event per match (status: MATCHED → MINED →
    // CONFIRMED). Our taker order_id is on `taker_order_id`; for our maker fills
    // the maker_orders[] entry carries our order_id. Reconcile both.
    const ourOrderIds: string[] = [];
    if (event.taker_order_id) ourOrderIds.push(event.taker_order_id);
    for (const m of event.maker_orders ?? []) {
      if (m.order_id) ourOrderIds.push(m.order_id);
    }

    const log = logger.child({
      tradeId: event.id,
      side: event.side,
      tx: event.transaction_hash,
      status: event.status,
    });

    let positionId: number | undefined;
    for (const oid of ourOrderIds) {
      const pid = await findPositionIdByOrderId(oid);
      if (pid) {
        positionId = pid;
        break;
      }
    }
    if (!positionId) {
      log.debug({ ourOrderIds }, "trade event for unrelated order — dropping");
      return;
    }

    const db = getDb();
    const sharesNum = Number(event.size);
    const priceNum = Number(event.price);
    const tsSec = Number(event.matchtime ?? event.timestamp ?? Math.floor(Date.now() / 1000));
    const txHash = event.transaction_hash ?? `pending-${event.id}`;

    // INV-M3: only persist closure when chain CONFIRMED. MATCHED is in-flight;
    // CONFIRMED means on-chain settlement is final.
    const confirmed = (event.status ?? "").toUpperCase() === "CONFIRMED";

    try {
      await db.insert(fills).values({
        positionId,
        txHash,
        side: event.side,
        shares: sharesNum,
        price: priceNum,
        feeUsd: 0,
        ts: tsSec,
        raw: event as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.debug({ err }, "fill insert conflict (idempotent retry)");
    }

    if (!confirmed) {
      log.debug({ status: event.status }, "trade not yet CONFIRMED — skipping status transition");
      return;
    }

    if (event.side === "BUY") {
      await this.onBuyFill(positionId, sharesNum, priceNum, tsSec);
    } else {
      await this.onSellFill(positionId, txHash, tsSec);
    }
  }

  onCancel(event: UserOrderEvent): void {
    logger.info(
      { orderID: event.id },
      "order canceled — next monitor tick will re-evaluate exit",
    );
  }

  private async onBuyFill(
    positionId: number,
    shares: number,
    price: number,
    tsSec: number,
  ): Promise<void> {
    const db = getDb();
    const pos = await db.query.positions.findFirst({ where: eq(positions.id, positionId) });
    if (!pos) return;
    // PENDING → FILLED → OPEN; no-op if already past
    if (pos.status === "PENDING" || pos.status === "FILLED") {
      await db
        .update(positions)
        .set({
          status: "OPEN",
          shares,
          fillPrice: price,
          peakPrice: price,
          fillTs: tsSec * 1000,
          lastStateChangeTs: Date.now(),
          entryCostUsd: shares * price,
          updatedAt: new Date(),
        })
        .where(eq(positions.id, positionId));
      logger.info({ positionId, shares, price }, "position OPEN (BUY filled on chain)");
    }
  }

  private async onSellFill(positionId: number, txHash: string, tsSec: number): Promise<void> {
    const db = getDb();
    const pos = await db.query.positions.findFirst({ where: eq(positions.id, positionId) });
    if (!pos) return;
    if (pos.status === "EXITING" || pos.status === "OPEN") {
      await db
        .update(positions)
        .set({
          status: "CLOSED",
          closeReason: "chain_sell_filled",
          closeTxHash: txHash,
          lastStateChangeTs: Date.now(),
          updatedAt: new Date(),
        })
        .where(eq(positions.id, positionId));
      logger.info({ positionId, txHash, tsSec }, "position CLOSED (SELL filled on chain)");
    }
  }
}
