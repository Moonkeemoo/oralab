import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DataActivity } from "../api/data.js";
import { getMarketByConditionId } from "../api/gamma.js";
import { getDb } from "../db/client.js";
import { positions, signals, strategies } from "../db/schema.js";
import { canAffordEntry } from "../execute/budget.js";
import { placeBuy } from "../execute/order_manager.js";
import { logger } from "../obs/logger.js";
import { whaleToBuyLatencyMs } from "../obs/metrics.js";
import { withSpan } from "../obs/tracer.js";
import { WhaleFollowStrategy } from "../strategies/whale_follow.js";
import type { Signal } from "../types/signal.js";
import type { Decision } from "../types/strategy.js";
import { matchWhale } from "./wallet_matcher.js";

/**
 * SignalRouter — converts an external whale BUY event into a Signal, runs it
 * through the matched Strategy, and on `enter` Decision posts a FOK BUY +
 * INSERTs a PENDING position row.
 *
 * Persists Signal regardless of outcome (audit trail). Records
 * whale_to_buy_latency_ms for end-to-end observability.
 */

interface BuildSignalArgs {
  whaleAddress: string;
  activity: DataActivity;
  strategyId: number;
}

function buildSignal(args: BuildSignalArgs, userId: number): Signal {
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
    },
    receivedTs: Date.now(),
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

    let decision: Decision = { kind: "skip", reason: "not_evaluated" };
    let accepted = false;
    let rejectReason: string | null = null;

    try {
      const market = await getMarketByConditionId(signal.conditionId);
      if (!market) {
        rejectReason = "market_not_found";
        await persistSignal(signal, false, rejectReason);
        return;
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
        makerFeeBps: market.maker_base_fee,
        takerFeeBps: market.taker_base_fee,
        tokens: market.tokens.map((t) => ({ tokenId: t.token_id, outcome: t.outcome })),
        endDate: market.endDate,
      };

      decision = await strategy.evaluate(signal, marketMeta);
      accepted = decision.kind === "enter";
      rejectReason = decision.kind === "skip" ? decision.reason : null;
      const signalId = await persistSignal(signal, accepted, rejectReason);

      if (decision.kind !== "enter") return;

      const balance = (await canAffordEntry(cfg.userId, match.strategyId, decision.sizeUsdHint))
        .budget.availableUsd;
      const sizeShares = strategy.sizing(decision, balance);
      if (sizeShares <= 0 || sizeShares < market.orderMinSize) {
        logger.warn(
          { sizeShares, minOrderSize: market.orderMinSize },
          "computed size below market minimum",
        );
        return;
      }

      const buy = await placeBuy({
        userId: cfg.userId,
        tokenId: signal.assetId,
        price: decision.priceCap,
        sizeShares,
        tickSize: marketMeta.tickSize,
        negRisk: marketMeta.negRisk,
        correlationId: `sig-${signalId}`,
      });

      if (!buy.success) {
        logger.warn({ errorCode: buy.errorCode, sigId: signalId }, "placeBuy rejected");
        return;
      }

      const db = getDb();
      await db.insert(positions).values({
        userId: cfg.userId,
        walletId: 1,
        strategyId: match.strategyId,
        signalId,
        conditionId: signal.conditionId,
        assetId: signal.assetId,
        side: signal.side,
        status: "PENDING",
        shares: sizeShares,
        fillPrice: decision.priceCap,
        peakPrice: decision.priceCap,
        fillTs: Date.now(),
        lastStateChangeTs: Date.now(),
        entryCostUsd: sizeShares * decision.priceCap,
        trailArmed: false,
        sweepCount: 0,
      });
      whaleToBuyLatencyMs.record(Date.now() - whaleStart, { source: "rest_poll" });
      logger.info(
        { sigId: signalId, sizeShares, priceCap: decision.priceCap, dry: buy.dry },
        "BUY queued — position PENDING",
      );
    } catch (err) {
      logger.error({ err, whale: whaleAddress }, "signal_router.route threw");
      await persistSignal(signal, false, "exception").catch(() => undefined);
    }
  });
}
