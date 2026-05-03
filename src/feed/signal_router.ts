import { randomUUID } from "node:crypto";
import process from "node:process";
import { and, eq, inArray } from "drizzle-orm";
import { getBookTop } from "../api/book.js";
import type { DataActivity } from "../api/data.js";
import { type GammaMarket, getMarketByTokenId } from "../api/gamma.js";
import { classifySport } from "../calibrator/sport_taxonomy.js";
import { getDb } from "../db/client.js";
import { orders, positions, signals, sportsEvents, strategies } from "../db/schema.js";
import { canAffordEntry } from "../execute/budget.js";
import { placeBuy } from "../execute/order_manager.js";
import { recordOrder } from "../execute/order_recorder.js";
import { telegramAlerterFromEnv } from "../notify/telegram.js";
import { logger } from "../obs/logger.js";
import { entryMutexWaitMs, entryRouteOutcome, whaleToBuyLatencyMs } from "../obs/metrics.js";
import { withTiming } from "../obs/timing.js";
import { withSpan } from "../obs/tracer.js";

const alerter = telegramAlerterFromEnv();
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

/**
 * Check whether `err` is a unique-constraint violation, optionally on a
 * specific constraint name. Drizzle wraps the underlying PostgresError
 * inside `cause`, so we have to peek both layers.
 */
function isUniqueConstraintError(err: unknown, constraintName?: string): boolean {
  const visit = (e: unknown): boolean => {
    if (!e || typeof e !== "object") return false;
    const o = e as { message?: string; code?: string; constraint_name?: string; cause?: unknown };
    const msg = o.message ?? "";
    const code = o.code ?? "";
    const matchUnique =
      code === "23505" || /duplicate key|unique constraint/i.test(msg);
    if (matchUnique) {
      if (!constraintName) return true;
      if (msg.includes(constraintName)) return true;
      if (o.constraint_name === constraintName) return true;
    }
    return o.cause ? visit(o.cause) : false;
  };
  return visit(err);
}

/**
 * Tiny TTL cache for gameId → league lookups against sports_events. The same
 * gameId is hit by every market on a game (winner/spread/totals/...), so the
 * 60s window prevents per-market round-trips while still picking up corrections
 * when a sports_events row gets backfilled mid-day.
 */
const LEAGUE_CACHE_TTL_MS = 60_000;
const LEAGUE_CACHE = new Map<string, { league: string | null; ts: number }>();

/**
 * Lightweight title-based league derivation. Polymarket sports market slugs
 * follow `{league}-{teams}-{date}-...` (mlb-nym-laa-2026-05-02, cs2-faze-furia-...,
 * epl-mun-liv-...). Used as fallback when gamma has no gameId AND for backfill.
 * Limited to short alphanumeric prefixes; rejects garbage like "will-tariff..." → null.
 */
export function deriveLeagueFromTitle(title: string | undefined | null): string | null {
  if (!title) return null;
  const m = title.toLowerCase().match(/^([a-z0-9]{2,12})-/);
  if (!m) return null;
  const lg = m[1] ?? "";
  // Filter common noise prefixes ("will-X-happen", "what-...", "who-...")
  if (["will", "what", "who", "is", "are"].includes(lg)) return null;
  return lg;
}

export async function deriveLeagueFromGameId(gameId: string): Promise<string | null> {
  const cached = LEAGUE_CACHE.get(gameId);
  const now = Date.now();
  if (cached && now - cached.ts < LEAGUE_CACHE_TTL_MS) return cached.league;
  try {
    const db = getDb();
    const row = await db.query.sportsEvents.findFirst({
      where: eq(sportsEvents.gameId, gameId),
      columns: { league: true },
    });
    const league = row?.league ?? null;
    LEAGUE_CACHE.set(gameId, { league, ts: now });
    // bound cache to last 500 gameIds — simple FIFO trim
    if (LEAGUE_CACHE.size > 500) {
      const firstKey = LEAGUE_CACHE.keys().next().value;
      if (firstKey !== undefined) LEAGUE_CACHE.delete(firstKey);
    }
    return league;
  } catch (err) {
    logger.debug({ err, gameId }, "deriveLeagueFromGameId failed — best effort");
    return null;
  }
}

async function persistSignal(
  signal: Signal,
  accepted: boolean,
  rejectReason: string | null,
  sport: string | null,
): Promise<number> {
  const db = getDb();
  try {
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
        sport,
        receivedTs: signal.receivedTs,
        processedAt: new Date(),
      })
      .returning({ id: signals.id });
    return Number(row?.id ?? 0);
  } catch (err) {
    // Likely uq_signals_dedup or similar — same whale txHash arriving twice
    // through RTDS. Don't crash the routing promise; signal already audited
    // by whichever path inserted it first.
    if (isUniqueConstraintError(err)) {
      logger.debug(
        { asset: signal.assetId, accepted, rejectReason },
        "persistSignal: duplicate signal — soft skip",
      );
      return 0;
    }
    throw err;
  }
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
  /** Canonical sport (NHL/MLB/Esports/...) inferred from gamma → sports_events.
   *  Null when not a classified sports market. Mirrored to signals.sport for
   *  per-sport rejection analytics. */
  sport?: string | null | undefined;
}

/**
 * Slippage policy for FOK BUY: read /book just before posting and use
 * `ask + N ticks` as the price ceiling. Without slippage tolerance, FOK
 * matched at exact ask is fragile to sub-second book moves.
 */
const FOK_SLIPPAGE_TICKS = Number(process.env["FOK_SLIPPAGE_TICKS"] ?? 2);

interface BookCacheEntry {
  ask: number;
  ts: number;
  tickSize: number;
}
const BOOK_CACHE = new Map<string, BookCacheEntry>();
const BOOK_TTL_MS = Number(process.env["LIVE_ASK_CACHE_TTL_MS"] ?? 500);

async function liveAskWithSlippage(market: GammaMarket, assetId: string): Promise<number | null> {
  const cached = BOOK_CACHE.get(assetId);
  if (cached && Date.now() - cached.ts < BOOK_TTL_MS) {
    return cached.ask + FOK_SLIPPAGE_TICKS * cached.tickSize;
  }
  try {
    const book = await getBookTop(assetId);
    if (book.ask <= 0 || book.ask >= 1) return null;
    BOOK_CACHE.set(assetId, {
      ask: book.ask,
      ts: Date.now(),
      tickSize: market.orderPriceMinTickSize,
    });
    // bound cache to last 200 assets — simple FIFO trim
    if (BOOK_CACHE.size > 200) {
      const firstKey = BOOK_CACHE.keys().next().value;
      if (firstKey !== undefined) BOOK_CACHE.delete(firstKey);
    }
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
    await persistSignal(signal, outcome.accepted, outcome.rejectReason, outcome.sport ?? classifySport(deriveLeagueFromTitle(signal.payload["title"] as string)));
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
  // signalId not yet known here (signal persisted at the end); positionId
  // not known until after INSERT. Use null at entry; later steps can
  // re-bind ctx. For the entry chain we only need `chain: "entry"`.
  const ctx = { signalId: null, positionId: null, chain: "entry" as const };

  const ageSec = (Date.now() - signal.receivedTs) / 1000;
  const STALE_AGE_SEC = Number(process.env["SIGNAL_STALE_AGE_SEC"] ?? 300);
  if (ageSec > STALE_AGE_SEC) {
    return { accepted: false, rejectReason: "signal_stale" };
  }

  const market = await withTiming(ctx, "gamma_fetch", () => getMarketByTokenId(signal.assetId));
  if (!market) return { accepted: false, rejectReason: "market_not_found" };
  if (market.closed || market.archived || market.umaResolutionStatus === "resolved") {
    return { accepted: false, rejectReason: "market_already_resolved" };
  }
  if (!market.acceptingOrders) {
    return { accepted: false, rejectReason: "market_not_accepting_orders" };
  }

  // Sport classification (Phase A calibrator foundation): derive league from
  // gamma.gameId → sports_events.league, then bucket via LEAGUE_TO_SPORT.
  // Both league + sport flow into positions on INSERT and into signals at
  // persistSignal so per-sport analytics + counterfactual aggregation work
  // across both accepted and rejected paths.
  const league = market.gameId ? await deriveLeagueFromGameId(market.gameId) : null;
  const sport = classifySport(league);

  // Pre-check unique constraint uq_positions_open_per_asset — if we already
  // have an active position on this asset (from another whale signal that
  // raced ahead), bail cheaply instead of catching the duplicate-key DB
  // error mid-INSERT (which currently crashes the routeInner promise).
  const dbPre = getDb();
  const existingActive = await dbPre.query.positions.findFirst({
    where: and(
      eq(positions.userId, cfg.userId),
      eq(positions.assetId, signal.assetId),
      inArray(positions.status, ["PENDING", "FILLED", "OPEN", "EXITING"] as const),
    ),
    columns: { id: true },
  });
  if (existingActive) {
    return { accepted: false, rejectReason: "already_open_for_asset", sport };
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

  const decision = await withTiming(ctx, "filter_pipeline", () =>
    strategy.evaluate(signal, marketMeta),
  );
  if (decision.kind !== "enter") {
    return { accepted: false, rejectReason: decision.reason, sport };
  }

  const balance = (await canAffordEntry(cfg.userId, strategyId, decision.sizeUsdHint)).budget
    .availableUsd;
  const sizeShares = strategy.sizing(decision, balance);
  if (sizeShares <= 0 || sizeShares < market.orderMinSize) {
    logger.warn(
      { sizeShares, minOrderSize: market.orderMinSize },
      "computed size below market minimum",
    );
    return { accepted: false, rejectReason: "below_min_size", sport };
  }

  // Use real /book ask + slippage. INV-D1: never trust whale's stale price for
  // the actual order. Falls back to whale price only if /book unavailable.
  const liveAsk = await withTiming(ctx, "live_ask", () =>
    liveAskWithSlippage(market, signal.assetId),
  );
  const priceCeiling = liveAsk ?? decision.priceCap;
  if (priceCeiling > 0.99) {
    return { accepted: false, rejectReason: "ask_at_ceiling", sport };
  }
  const usdAmount = sizeShares * priceCeiling;

  const buy = await withTiming(ctx, "place_buy", () =>
    placeBuy({
      userId: cfg.userId,
      tokenId: signal.assetId,
      price: priceCeiling,
      usdAmount,
      tickSize: marketMeta.tickSize,
      negRisk: marketMeta.negRisk,
      correlationId: `sig-${signal.id}`,
    }),
  );

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
    return { accepted: false, rejectReason: buy.errorCode ?? "placebuy_failed", sport };
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
    return { accepted: false, rejectReason: "live_zero_fill", sport };
  }
  const status: "OPEN" | "PENDING" = buy.dry ? "PENDING" : "OPEN";

  const db = getDb();
  let posRow: { id: number } | undefined;
  try {
    const inserted = await withTiming(ctx, "position_insert", () =>
      db
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
          mode: (process.env["DRY_RUN"] ?? "true").toLowerCase() === "true" ? "DRY" : "LIVE",
          shares: filledShares,
          fillPrice: priceCeiling,
          peakPrice: priceCeiling,
          fillTs: Date.now(),
          lastStateChangeTs: Date.now(),
          entryCostUsd: filledShares * priceCeiling,
          trailArmed: false,
          sweepCount: 0,
          league: league ?? deriveLeagueFromTitle(signal.payload["title"] as string | undefined),
          sport: sport ?? classifySport(deriveLeagueFromTitle(signal.payload["title"] as string | undefined)),
          whaleAddress: (signal.payload["whaleAddress"] as string | undefined)?.toLowerCase() ?? null,
        })
        .returning({ id: positions.id }),
    );
    posRow = inserted[0];
  } catch (err) {
    // Race: another routeInner inserted a position for the same asset between
    // our pre-check and this INSERT. The DB unique constraint
    // uq_positions_open_per_asset is the canonical guarantee — accept the
    // rejection cleanly instead of crashing the promise.
    if (isUniqueConstraintError(err, "uq_positions_open_per_asset")) {
      logger.info(
        { asset: signal.assetId },
        "INSERT lost race against another active position for this asset — soft reject",
      );
      return { accepted: false, rejectReason: "already_open_for_asset", sport };
    }
    throw err;
  }

  const positionId = Number(posRow?.id ?? 0);

  // Backlink the order row inserted earlier to this position.
  // recordOrder() was called BEFORE the INSERT (so the audit trail is
  // preserved even if the INSERT loses the unique-constraint race), but
  // its position_id is null — DryFillSimulator's INNER JOIN on
  // orders.position_id = positions.id then never matches and PENDING
  // positions stay frozen. Backlink keyed on client_order_id (unique).
  await db
    .update(orders)
    .set({ positionId })
    .where(eq(orders.clientOrderId, buy.clientOrderId));

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

  // Telegram alert (only LIVE — DRY runs would spam test channels)
  if (!buy.dry && positionId > 0) {
    void alerter.buyPlaced({
      positionId,
      asset: signal.assetId,
      title: signal.payload["title"] as string | undefined,
      shares: filledShares,
      price: priceCeiling,
      usdSpent: filledShares * priceCeiling,
    });
  }

  return {
    accepted: true,
    rejectReason: null,
    positionId,
    clobOrderId: buy.clobOrderId,
    sport,
  };
}
