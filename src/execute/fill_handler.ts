import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fills, positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import type { FillHandler, OrderCanceledEvent, OwnFillEvent } from "./fill_reconciler.js";
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
  async onFill(event: OwnFillEvent): Promise<void> {
    const log = logger.child({
      orderID: event.orderID,
      side: event.side,
      tx: event.transactionHash,
    });
    const positionId = await findPositionIdByOrderId(event.orderID);
    if (!positionId) {
      log.warn("fill received but no matching order in DB — dropping (likely manual or stale)");
      return;
    }

    const db = getDb();
    const sharesNum = Number(event.size);
    const priceNum = Number(event.price);
    const feeNum = Number(event.fee);
    const tsNum = Number(event.timestamp);

    // 1. INSERT fill row (idempotent via unique tx_hash+position_id)
    try {
      await db.insert(fills).values({
        positionId,
        txHash: event.transactionHash,
        side: event.side,
        shares: sharesNum,
        price: priceNum,
        feeUsd: feeNum,
        ts: tsNum,
        raw: event as unknown as Record<string, unknown>,
      });
    } catch (err) {
      log.debug({ err }, "fill insert conflict (idempotent retry)");
    }

    // 2. Transition position status
    if (event.side === "BUY") {
      await this.onBuyFill(positionId, sharesNum, priceNum, tsNum);
    } else {
      await this.onSellFill(positionId, event.transactionHash, tsNum);
    }
  }

  onCancel(event: OrderCanceledEvent): void {
    logger.info(
      { orderID: event.orderID, reason: event.reason },
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
