import { randomUUID } from "node:crypto";
import process from "node:process";
import { eq } from "drizzle-orm";
import { getBookTop } from "../api/book.js";
import type { DataActivity } from "../api/data.js";
import { type GammaMarket, getMarketByTokenId } from "../api/gamma.js";
import { getDb } from "../db/client.js";
import { positions, signals, strategies } from "../db/schema.js";
import { canAffordEntry } from "../execute/budget.js";
import { placeBuy } from "../execute/order_manager.js";
import { recordOrder } from "../execute/order_recorder.js";
import { logger } from "../obs/logger.js";
import { entryMutexWaitMs, entryRouteOutcome, whaleToBuyLatencyMs } from "../obs/metrics.js";
import { withSpan } from "../obs/tracer.js";
import { WhaleFollowStrategy } from "../strategies/whale_follow.js";
import type { Signal } from "../types/signal.js";
import { serializedEntry } from "./entry_mutex.js";
import { matchWhale } from "./wallet_matcher.js";

/**
 * SignalRouter — converts an external whale BUY event into a Signal, runs it
 * through the matched Strategy, and on `enter` Decision posts a FOK BUY.
 *
 * Persists Signal once at the END with the final outcome (audit trail accurate).
 * Position INSERT happens only after CLOB success + non-zero fill (LIVE) or
 * on every successful DRY_RUN response (DRY).
 */

interface BuildSignalArgs {
  whaleAddress: string;
  activity: DataActivity;
  strategyId: number;
}

function buildSignal(args: BuildSignalArgs, userId: number): Signal {
  const whaleTradeTsMs = args.activity.timestamp * 1000;
  return {
    id: `sig-${randomUUID()}`,
    userId,
    strategyId: String(args.strategyId),
    source: "whale_chain",
    conditionId: args.activity.conditionId,
    assetId: args.activity.asset,
    side: "YES",
    priceHint: args.activity.price,
    volumeUsdHint: args.activity.size * args.activity.price,
    payload: {
      whaleAddress: args.whaleAddress.toLowerCase(),
      txHash: args.activity.transactionHash,
      whaleSizeShares: args.activity.size,
      title: args.activity.title,
      whaleTradeTsMs,
    },
    receivedTs: whaleTradeTsMs,
  };
}

async function persistSignal(
  signal: Signal,
  accepted: boolean,
  rejectReason: string | null,
): Promise<number> {
  const db = getDb();
  const [row] = await db
    .insert(signals)
    .values({
      userId: signal.userId,
      strategyId: Number(signal.strategyId),
      source: signal.source,
      conditionId: signal.conditionId,
      assetId: signal.assetId,
      side: signal.side,
      priceHint: signal.priceHint,
      volumeUsdHint: signal.volumeUsdHint,
      payload: signal.payload,
      accepted,
      rejectReason,
      receivedTs: signal.receivedTs,
      processedAt: new Date(),
    })
    .returning({ id: signals.id });
  return Number(row?.id ?? 0);
}

async function strategyConfigById(strategyId: number) {
  const db = getDb();
  const row = await db.query.strategies.findFirst({ where: eq(strategies.id, strategyId) });
  if (!row) throw new Error(`strategy ${strategyId} not found`);
  return {
    id: String(row.id),
    userId: Number(row.userId),
    kind: row.kind as "whale_follow",
    enabled: row.enabled,
    params: (row.params as Record<string, unknown>) ?? {},
  };
}

interface RouteOutcome {
  accepted: boolean;
  rejectReason: string | null;
  positionId?: number | undefined;
  clobOrderId?: string | undefined;
}

/**
 * Slippage policy for FOK BUY: read /book just before posting and use
 * `ask + N ticks` as the price ceiling. Without slippage tolerance, FOK
 * matched at exact ask is fragile to sub-second book moves.
 */
const FOK_SLIPPAGE_TICKS = Number(process.env["FOK_SLIPPAGE_TICKS"] ?? 2);

async function liveAskWithSlippage(market: GammaMarket, assetId: string): Promise<number | null> {
  try {
    const book = await getBookTop(assetId);
    if (book.ask <= 0 || book.ask >= 1) return null;
    return book.ask + FOK_SLIPPAGE_TICKS * market.orderPriceMinTickSize;
  } catch (err) {
    logger.warn({ err, asset: assetId }, "getBookTop failed; will fall back to signal.priceHint");
    return null;
  }
}

export async function routeWhaleBuy(whaleAddress: string, activity: DataActivity): Promise<void> {
  const whaleStart = activity.timestamp * 1000;
  const match = await matchWhale(whaleAddress);
  if (!match) {
    logger.debug({ whale: whaleAddress }, "whale not tracked — drop");
    return;
  }

  const cfg = await strategyConfigById(match.strategyId);
  if (!cfg.enabled) {
    logger.debug({ strategy: cfg.id }, "strategy disabled — drop");
    return;
  }

  const signal = buildSignal({ whaleAddress, activity, strategyId: match.strategyId }, cfg.userId);

  await withSpan("signal_router.route", async (span) => {
    span.setAttribute("whale", whaleAddress);
    span.setAttribute("asset", signal.assetId);

    const enqueuedAt = performance.now();
    const outcome = await serializedEntry(cfg.userId, match.strategyId, async () => {
      entryMutexWaitMs.record(performance.now() - enqueuedAt);
      return routeInner(signal, cfg, match.strategyId);
    });
    await persistSignal(signal, outcome.accepted, outcome.rejectReason);
    entryRouteOutcome.add(1, {
      outcome: outcome.accepted ? "accepted" : (outcome.rejectReason ?? "unknown"),
    });

    if (outcome.accepted) {
      whaleToBuyLatencyMs.record(Date.now() - whaleStart, { source: "rtds" });
    }
  });
}

async function routeInner(
  signal: Signal,
  cfg: Awaited<ReturnType<typeof strategyConfigById>>,
  strategyId: number,
): Promise<RouteOutcome> {
  const ageSec = (Date.now() - signal.receivedTs) / 1000;
  const STALE_AGE_SEC = Number(process.env["SIGNAL_STALE_AGE_SEC"] ?? 300);
  if (ageSec > STALE_AGE_SEC) {
    return { accepted: false, rejectReason: "signal_stale" };
  }

  const market = await getMarketByTokenId(signal.assetId);
  if (!market) return { accepted: false, rejectReason: "market_not_found" };
  if (market.closed || market.archived || market.umaResolutionStatus === "resolved") {
    return { accepted: false, rejectReason: "market_already_resolved" };
  }
  if (!market.acceptingOrders) {
    return { accepted: false, rejectReason: "market_not_accepting_orders" };
  }

  const strategy = new WhaleFollowStrategy({
    id: cfg.id,
    userId: cfg.userId,
    kind: cfg.kind,
    enabled: cfg.enabled,
    params: cfg.params,
  });

  const marketMeta = {
    conditionId: market.conditionId,
    slug: market.slug,
    question: market.question,
    negRisk: market.negRisk,
    tickSize: market.orderPriceMinTickSize,
    minOrderSize: market.orderMinSize,
    makerFeeBps: market.makerBaseFee,
    takerFeeBps: market.takerBaseFee,
    tokens: market.tokens,
    endDate: market.endDate,
    isSportsMarket: market.isSportsMarket,
    gameId: market.gameId,
    sportsMarketType: market.sportsMarketType,
  };

  const decision = await strategy.evaluate(signal, marketMeta);
  if (decision.kind !== "enter") {
    return { accepted: false, rejectReason: decision.reason };
  }

  const balance = (await canAffordEntry(cfg.userId, strategyId, decision.sizeUsdHint)).budget
    .availableUsd;
  const sizeShares = strategy.sizing(decision, balance);
  if (sizeShares <= 0 || sizeShares < market.orderMinSize) {
    logger.warn(
      { sizeShares, minOrderSize: market.orderMinSize },
      "computed size below market minimum",
    );
    return { accepted: false, rejectReason: "below_min_size" };
  }

  // Use real /book ask + slippage. INV-D1: never trust whale's stale price for
  // the actual order. Falls back to whale price only if /book unavailable.
  const liveAsk = await liveAskWithSlippage(market, signal.assetId);
  const priceCeiling = liveAsk ?? decision.priceCap;
  if (priceCeiling > 0.99) {
    return { accepted: false, rejectReason: "ask_at_ceiling" };
  }
  const usdAmount = sizeShares * priceCeiling;

  const buy = await placeBuy({
    userId: cfg.userId,
    tokenId: signal.assetId,
    price: priceCeiling,
    usdAmount,
    tickSize: marketMeta.tickSize,
    negRisk: marketMeta.negRisk,
    correlationId: `sig-${signal.id}`,
  });

  // Always record the order attempt — audit trail of every CLOB call.
  await recordOrder({
    userId: cfg.userId,
    positionId: null,
    mode: "FOK",
    side: "BUY",
    price: priceCeiling,
    size: sizeShares,
    clientOrderId: buy.clientOrderId,
    clobOrderId: buy.clobOrderId,
    status: buy.status ?? (buy.dry ? "DRY_RUN" : "LIVE"),
    errorCode: buy.errorCode,
    rawRequest: {
      tokenId: signal.assetId,
      price: priceCeiling,
      usdAmount,
      sizeSharesIntended: sizeShares,
    },
    rawResponse: (buy.raw as Record<string, unknown>) ?? {},
  });

  if (!buy.success) {
    logger.warn(
      { errorCode: buy.errorCode, status: buy.status },
      "placeBuy rejected — no position created",
    );
    return { accepted: false, rejectReason: buy.errorCode ?? "placebuy_failed" };
  }

  // SUCCESS path. Record ACTUAL filled shares from CLOB response (handles
  // partial fills correctly). In DRY mode CLOB isn't called so we use the
  // intended shares + status PENDING — DryFillSimulator promotes to OPEN.
  // In LIVE: if takingAmount > 0 → OPEN with that exact size; else PENDING
  // (FillReconciler will see WS event eventually).
  const filledShares = buy.dry ? sizeShares : Number(buy.takingAmount ?? 0);
  if (!buy.dry && filledShares <= 0) {
    // Defensive: should be caught by fok_unfilled in placeBuy, but if a future
    // CLOB shape slips by we still don't INSERT a phantom position.
    logger.warn(
      { clobOrderId: buy.clobOrderId },
      "placeBuy success=true but takingAmount=0 in LIVE — declining to INSERT",
    );
    return { accepted: false, rejectReason: "live_zero_fill" };
  }
  const status: "OPEN" | "PENDING" = buy.dry ? "PENDING" : "OPEN";

  const db = getDb();
  const [posRow] = await db
    .insert(positions)
    .values({
      userId: cfg.userId,
      walletId: 1,
      strategyId,
      signalId: null,
      conditionId: signal.conditionId,
      assetId: signal.assetId,
      side: signal.side,
      status,
      shares: filledShares,
      fillPrice: priceCeiling,
      peakPrice: priceCeiling,
      fillTs: Date.now(),
      lastStateChangeTs: Date.now(),
      entryCostUsd: filledShares * priceCeiling,
      trailArmed: false,
      sweepCount: 0,
    })
    .returning({ id: positions.id });

  const positionId = Number(posRow?.id ?? 0);
  logger.info(
    {
      positionId,
      sizeShares: filledShares,
      priceCeiling,
      status,
      dry: buy.dry,
      clobOrderId: buy.clobOrderId,
    },
    "BUY placed — position recorded",
  );
  return {
    accepted: true,
    rejectReason: null,
    positionId,
    clobOrderId: buy.clobOrderId,
  };
}
