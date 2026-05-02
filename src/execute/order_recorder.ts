import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { orders } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * Persist an order placement attempt into the `orders` table so the
 * FillReconciler can later resolve a CLOB orderID back to (positionId, side,
 * size, price). Single source of order-history truth — DB is the cache,
 * `/activity` is the chain authority.
 */

export interface OrderInsert {
  readonly userId: number;
  readonly positionId?: number | null;
  readonly mode: "FOK" | "FAK" | "GTD" | "GTC";
  readonly side: "BUY" | "SELL";
  readonly price: number;
  readonly size: number;
  readonly clientOrderId: string;
  readonly clobOrderId?: string | null | undefined;
  readonly status: string;
  readonly errorCode?: string | null | undefined;
  readonly expirationTs?: number | null | undefined;
  readonly rawRequest: Record<string, unknown>;
  readonly rawResponse: Record<string, unknown>;
}

export async function recordOrder(o: OrderInsert): Promise<number> {
  const db = getDb();
  const [row] = await db
    .insert(orders)
    .values({
      userId: o.userId,
      positionId: o.positionId ?? null,
      mode: o.mode,
      side: o.side,
      price: o.price,
      size: o.size,
      clientOrderId: o.clientOrderId,
      clobOrderId: o.clobOrderId ?? null,
      status: o.status,
      errorCode: o.errorCode ?? null,
      expirationTs: o.expirationTs ?? null,
      rawRequest: o.rawRequest,
      rawResponse: o.rawResponse,
    })
    .returning({ id: orders.id });
  return Number(row?.id ?? 0);
}

export async function findPositionIdByOrderId(clobOrderId: string): Promise<number | null> {
  const db = getDb();
  const row = await db.query.orders.findFirst({
    where: eq(orders.clobOrderId, clobOrderId),
  });
  if (!row?.positionId) {
    logger.debug({ clobOrderId }, "no position for clobOrderId");
    return null;
  }
  return Number(row.positionId);
}
