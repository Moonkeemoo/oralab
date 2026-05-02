import process from "node:process";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { positions } from "../db/schema.js";
import { logger } from "../obs/logger.js";
import { withTiming } from "../obs/timing.js";
import type { ExitIntent } from "../types/decide.js";
import type { MarketSnapshot } from "../types/market.js";
import type { PositionView } from "../types/position.js";
import {
  cancelByOrderId,
  cancelOpenOrdersForAsset,
  type OrderResult,
  placeSell,
} from "./order_manager.js";
import { recordOrder } from "./order_recorder.js";

/**
 * ExitExecutor — the ONLY thing that mutates state on the exit path.
 *
 * Honors INV-M5 (no double-act): refuses to escalate if the position is
 * already in EXITING with a recent state change unless the intent is a
 * deliberate retry (sweepCount has incremented). Refuses redeem/freeze for
 * positions whose status doesn't match.
 *
 * Translates ExitIntent → SellParams; calls placeSell from OrderManager
 * (DRY/LIVE handled inside). Persists status transition into EXITING.
 */

export interface ExecuteOutcome {
  readonly applied: boolean;
  readonly skipReason?: string;
  readonly orderResult?: OrderResult;
}

/**
 * Polymarket V2 requires GTD expiration ≥ now + 60s + 30s buffer (security
 * threshold: "If the order needs to expire in 30 seconds the correct
 * expiration value is: now + 1 minute + 30 seconds"). Default 120s gives a
 * generous buffer past validation while still recycling inside a couple
 * sweep cycles.
 */
const SELL_GTD_DEFAULT_SEC = Number(process.env["SELL_GTD_DEFAULT_SEC"] ?? 120);

/**
 * Minimum interval between sweep retries on the same position. Without this,
 * the 2 Hz PositionMonitor fires a fresh SELL every tick, hammering CLOB and
 * never giving any single GTD time to match. Default 5s lets the prior sweep
 * sit for 10 ticks before being cancel-and-replaced.
 */
const SWEEP_COOLDOWN_MS = Number(process.env["SWEEP_COOLDOWN_MS"] ?? 5000);

export async function executeExitIntent(
  pos: PositionView,
  snap: MarketSnapshot,
  intent: ExitIntent,
): Promise<ExecuteOutcome> {
  const log = logger.child({
    posId: pos.id,
    intent: intent.action,
    reason: intent.reason,
  });

  if (intent.action === "hold") return { applied: false, skipReason: "hold" };
  if (intent.action === "freeze") {
    // Reconciler is the canonical writer of FROZEN; here we no-op so
    // we don't double-write. Log for audit.
    log.warn("decide_exit returned freeze; reconciler should set status");
    return { applied: false, skipReason: "freeze_handled_by_reconciler" };
  }

  if (intent.action === "redeem") {
    log.info("REDEEM intent — CTF redeem not implemented in P1; logging for follow-up");
    return { applied: false, skipReason: "redeem_not_implemented_p1" };
  }

  // INV-M5: don't fire a second SELL while one is in flight, unless sweep retry.
  if (pos.status === "EXITING" && pos.sweepCount === 0) {
    log.warn("INV-M5: position already EXITING with sweepCount=0; refusing duplicate");
    return { applied: false, skipReason: "double_act_blocked" };
  }

  // Sweep cooldown: don't bombard CLOB with cancel/replace every PositionMonitor
  // tick. Give the in-flight GTD a chance to match before swapping it out.
  if (pos.status === "EXITING" && pos.sweepCount > 0) {
    const sinceLastSweepMs = Date.now() - pos.lastStateChangeTs;
    if (sinceLastSweepMs < SWEEP_COOLDOWN_MS) {
      return {
        applied: false,
        skipReason: `sweep_cooldown ${Math.round(sinceLastSweepMs)}ms<${SWEEP_COOLDOWN_MS}ms`,
      };
    }
  }

  const ctx = {
    signalId: null,
    positionId: typeof pos.id === "number" ? pos.id : Number(pos.id) || null,
    chain: "exit" as const,
  };

  // QA-174 cancel-before-place: if this is a sweep retry, kill any prior open
  // SELL orders for this asset before placing the new one. Active enumeration,
  // not idempotency assumption. No-op in DRY.
  if (pos.sweepCount > 0) {
    const cancel = await withTiming(ctx, "cancel_open", () =>
      cancelOpenOrdersForAsset(pos.assetId, "SELL"),
    );
    if (cancel.cancelled > 0) {
      log.info({ cancelled: cancel.cancelled }, "QA-174 cancel-before-place cleared prior SELLs");
    }
  }

  const db = getDb();
  const numericId = Number(pos.id);

  const sellParams = {
    userId: pos.userId,
    tokenId: pos.assetId,
    price: intent.price,
    sizeShares: intent.size,
    tickSize: snap.tickSize,
    negRisk: snap.negRisk,
    expirationTs: Math.floor(Date.now() / 1000) + SELL_GTD_DEFAULT_SEC,
    // sell_fok = emergency dump-at-floor: must fill immediately or be killed.
    // Use FOK market order (createAndPostMarketOrder), NOT GTC limit (which
    // would sit forever).
    orderType: intent.action === "sell_fok" ? ("FOK" as const) : ("GTD" as const),
    postOnly: intent.action === "sell_bid_probe",
    correlationId: `pos-${pos.id}-sweep-${pos.sweepCount}`,
  };

  const result = await withTiming(ctx, "place_sell", () => placeSell(sellParams));

  if (!result.success) {
    log.warn(
      { errorCode: result.errorCode },
      "placeSell failed — leaving position state untouched",
    );
    return { applied: false, orderResult: result, skipReason: result.errorCode ?? "place_failed" };
  }

  // Transition to EXITING (if not already), bump sweepCount.
  await withTiming(ctx, "position_update", () =>
    db
      .update(positions)
      .set({
        status: "EXITING",
        sweepCount: pos.sweepCount + 1,
        lastStateChangeTs: Date.now(),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, numericId)),
  );

  await recordOrder({
    userId: pos.userId,
    positionId: numericId,
    mode: sellParams.orderType,
    side: "SELL",
    price: sellParams.price,
    size: sellParams.sizeShares,
    expirationTs: sellParams.expirationTs,
    clientOrderId: result.clientOrderId,
    clobOrderId: result.clobOrderId,
    status: result.status ?? (result.dry ? "DRY_RUN" : "LIVE"),
    rawRequest: { ...sellParams, action: intent.action, reason: intent.reason },
    rawResponse: (result.raw as Record<string, unknown>) ?? {},
  });

  log.info({ orderId: result.clobOrderId, sweepCount: pos.sweepCount + 1 }, "position → EXITING");
  return { applied: true, orderResult: result };
}

/**
 * Cancel pending SELL on a position (used when entering a new sweep with
 * different price). Idempotent (INV-O2): cancel of already-expired orders
 * returns success.
 */
export async function cancelPendingSell(positionId: number, clobOrderId: string): Promise<void> {
  await cancelByOrderId(clobOrderId);
  logger.debug({ positionId, clobOrderId }, "cancelled pending sell");
}
