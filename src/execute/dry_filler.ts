import process from "node:process";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fills, orders, positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * DRY-mode fill simulator.
 *
 * In LIVE mode the FillReconciler subscribes to user WS and writes `fills`
 * rows + transitions positions PENDING→OPEN / EXITING→CLOSED on real chain
 * confirmations. In DRY no orders post; without a substitute path PENDING
 * positions sit forever and reconciler eventually freezes them. That kills
 * the ability to exercise the exit-side pipeline locally.
 *
 * This filler runs only when `DRY_SIMULATE_FILLS=true`. It periodically:
 *   - finds PENDING positions whose linked BUY order was DRY_RUN-accepted,
 *     and after a small lag transitions to OPEN with the same shares/price.
 *   - finds EXITING positions whose linked SELL order was DRY_RUN-accepted,
 *     and after a small lag transitions to CLOSED with closeReason
 *     "dry_simulated_sell_fill" + a synthetic txHash.
 *
 * Lag exists so the bot's own sequencing (PENDING window, EXITING grace) is
 * still observable in metrics. This is a *test-mode* component — never enabled
 * with real money flow.
 */

const PENDING_FILL_LAG_MS = 1_500;
const EXITING_FILL_LAG_MS = 2_500;

function isEnabled(): boolean {
  return (process.env["DRY_SIMULATE_FILLS"] ?? "false").toLowerCase() === "true";
}

async function fillPendingBuys(): Promise<void> {
  const db = getDb();
  const cutoff = Date.now() - PENDING_FILL_LAG_MS;
  const candidates = await db
    .select({
      posId: positions.id,
      shares: positions.shares,
      fillPrice: positions.fillPrice,
      orderTxHashSeed: orders.clientOrderId,
    })
    .from(positions)
    .innerJoin(orders, and(eq(orders.positionId, positions.id), eq(orders.side, "BUY")))
    .where(
      and(
        eq(positions.status, "PENDING"),
        eq(orders.status, "DRY_RUN"),
        lte(positions.lastStateChangeTs, cutoff),
      ),
    )
    .limit(50);

  for (const c of candidates) {
    const txHash = `0xdry${c.orderTxHashSeed.replace(/-/g, "").slice(0, 60)}`;
    try {
      await db.insert(fills).values({
        positionId: Number(c.posId),
        txHash,
        side: "BUY",
        shares: Number(c.shares),
        price: Number(c.fillPrice),
        feeUsd: 0,
        ts: Math.floor(Date.now() / 1000),
        raw: { simulated: true } as Record<string, unknown>,
      });
    } catch {
      // unique constraint hit — already simulated, skip
    }
    await db
      .update(positions)
      .set({
        status: "OPEN",
        peakPrice: Number(c.fillPrice),
        lastStateChangeTs: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, c.posId));
    logger.info({ posId: Number(c.posId), simulated: true }, "DRY fill: PENDING → OPEN");
  }
}

async function fillExitingSells(): Promise<void> {
  const db = getDb();
  const cutoff = Date.now() - EXITING_FILL_LAG_MS;
  const candidates = await db
    .select({
      posId: positions.id,
      sellPrice: orders.price,
      sellSize: orders.size,
      sellClientId: orders.clientOrderId,
    })
    .from(positions)
    .innerJoin(orders, and(eq(orders.positionId, positions.id), eq(orders.side, "SELL")))
    .where(
      and(
        eq(positions.status, "EXITING"),
        inArray(orders.status, ["DRY_RUN"]),
        lte(positions.lastStateChangeTs, cutoff),
      ),
    )
    .orderBy(sql`${orders.createdAt} DESC`)
    .limit(50);

  const seen = new Set<number>();
  for (const c of candidates) {
    const posId = Number(c.posId);
    if (seen.has(posId)) continue;
    seen.add(posId);

    const txHash = `0xdry${c.sellClientId.replace(/-/g, "").slice(0, 60)}`;
    try {
      await db.insert(fills).values({
        positionId: posId,
        txHash,
        side: "SELL",
        shares: Number(c.sellSize),
        price: Number(c.sellPrice),
        feeUsd: 0,
        ts: Math.floor(Date.now() / 1000),
        raw: { simulated: true } as Record<string, unknown>,
      });
    } catch {
      // already filled
    }
    await db
      .update(positions)
      .set({
        status: "CLOSED",
        closeReason: "dry_simulated_sell_fill",
        closeTxHash: txHash,
        lastStateChangeTs: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, c.posId));
    logger.info({ posId, simulated: true }, "DRY fill: EXITING → CLOSED");
  }
}

export class DryFillSimulator {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (!isEnabled()) {
      logger.info("DRY_SIMULATE_FILLS=false — DryFillSimulator not started");
      return;
    }
    if (this.timer) return;
    logger.info("DRY_SIMULATE_FILLS=true — DryFillSimulator started");
    this.timer = setInterval(() => {
      void fillPendingBuys().catch((err) => logger.error({ err }, "fillPendingBuys threw"));
      void fillExitingSells().catch((err) => logger.error({ err }, "fillExitingSells threw"));
    }, 500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const dryFillEnabled = isEnabled;
