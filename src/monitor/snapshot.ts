import process from "node:process";
import { getBookTop } from "../api/book.js";
import { type DataPosition, getPositions } from "../api/data.js";
import { getMarketByTokenId } from "../api/gamma.js";
import { getWsBook } from "../feed/market_book_ws.js";
import { logger } from "../obs/logger.js";
import type { MarketSnapshot } from "../types/market.js";

/**
 * MarketSnapshot builder — INV-D1 source-of-truth assembly.
 *
 *   bid/ask  ← clob /book   (NEVER /midpoint, NEVER mark*0.99 synthesis — QA-180)
 *   negRisk
 *   tickSize
 *   minOrderSize
 *   outcomePrices ← gamma   (NEVER hardcoded)
 *   acceptingOrders
 *   umaResolutionStatus
 *   resolved
 *
 * Caches: in-process, 3s TTL on /book (see architecture §06 latency budget).
 */

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

// Mark must stay sub-second for SL/TP/trail to fire on real moves. Default
// 500ms = same as PositionMonitor tick — every other tick triggers a fresh
// /book; the alternates re-use cache to keep REST volume bounded. Override
// via SNAPSHOT_BOOK_TTL_MS for tuning. WS market book (when subscribed)
// short-circuits this path entirely with sub-100ms freshness.
const BOOK_TTL_MS = Number(process.env["SNAPSHOT_BOOK_TTL_MS"] ?? 500);
const GAMMA_TTL_MS = 30_000; // gamma metadata changes rarely
const WS_BOOK_MAX_AGE_MS = Number(process.env["WS_BOOK_MAX_AGE_MS"] ?? 5_000);

const _bookCache = new Map<string, CacheEntry<Awaited<ReturnType<typeof getBookTop>>>>();
const _gammaCache = new Map<
  string,
  CacheEntry<NonNullable<Awaited<ReturnType<typeof getMarketByTokenId>>>>
>();

async function cachedBookTop(tokenId: string): Promise<Awaited<ReturnType<typeof getBookTop>>> {
  const now = Date.now();
  const cached = _bookCache.get(tokenId);
  if (cached && now - cached.fetchedAt < BOOK_TTL_MS) return cached.value;
  const value = await getBookTop(tokenId);
  _bookCache.set(tokenId, { value, fetchedAt: now });
  return value;
}

interface WsBookView {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  timestampMs: number;
  source: "ws_book";
}

/**
 * Try the live WS market-channel book first; if absent or staler than
 * WS_BOOK_MAX_AGE_MS, the caller falls back to REST. Lookup is sub-ms.
 */
function tryWsBook(tokenId: string): WsBookView | null {
  const w = getWsBook(tokenId);
  if (!w) return null;
  if (Date.now() - w.ts > WS_BOOK_MAX_AGE_MS) return null;
  return {
    bid: w.bid,
    ask: w.ask,
    bidSize: w.bidSize,
    askSize: w.askSize,
    timestampMs: w.ts,
    source: "ws_book",
  };
}

async function cachedGamma(tokenId: string) {
  const now = Date.now();
  const cached = _gammaCache.get(tokenId);
  if (cached && now - cached.fetchedAt < GAMMA_TTL_MS) return cached.value;
  const value = await getMarketByTokenId(tokenId);
  if (!value) throw new Error(`gamma market not found for token ${tokenId}`);
  _gammaCache.set(tokenId, { value, fetchedAt: now });
  return value;
}

function expectedOutcomeForSide(prices: readonly number[], side: "YES" | "NO"): number {
  // Polymarket convention: outcomes are typically ["Yes","No"] or two team names.
  // For a YES-side position, our expected value is prices[0] (long the first outcome).
  const idx = side === "YES" ? 0 : 1;
  return prices[idx] ?? 0;
}

function endDateMs(endDate: string): number {
  const t = Date.parse(endDate);
  return Number.isFinite(t) ? t : 0;
}

export async function buildSnapshot(
  conditionId: string,
  assetId: string,
  side: "YES" | "NO",
): Promise<MarketSnapshot> {
  // Prefer fresh WS book; fall back to REST cached_book.
  const wsTop = tryWsBook(assetId);
  const [restBook, gamma] = await Promise.all([
    wsTop ? Promise.resolve(null as null) : cachedBookTop(assetId),
    cachedGamma(assetId),
  ]);
  const book = wsTop ?? restBook!;
  const markSource: MarketSnapshot["markSource"] = wsTop ? "ws_book" : "rest_book";

  const expectedOutcomeValue = expectedOutcomeForSide(gamma.outcomePricesParsed, side);
  const mark = (book.bid + book.ask) / 2;
  const winningOutcomeIndex =
    gamma.umaResolutionStatus === "resolved"
      ? gamma.outcomePricesParsed.indexOf(Math.max(...gamma.outcomePricesParsed))
      : null;
  const markTs = wsTop
    ? wsTop.timestampMs
    : restBook && restBook.timestampMs > 0
      ? restBook.timestampMs
      : Date.now();

  return {
    conditionId,
    assetId,
    bid: book.bid,
    ask: book.ask,
    bidSize: book.bidSize,
    askSize: book.askSize,
    mark,
    markSource,
    markTs,
    tickSize: gamma.orderPriceMinTickSize,
    negRisk: gamma.negRisk,
    minOrderSize: gamma.orderMinSize,
    expectedOutcomeValue,
    acceptingOrders: gamma.acceptingOrders,
    umaResolutionStatus: gamma.umaResolutionStatus as "proposed" | "disputed" | "resolved" | null,
    resolved: gamma.umaResolutionStatus === "resolved",
    winningOutcomeIndex,
    endDateTs: endDateMs(gamma.endDate),
    fetchedAt: Date.now(),
  };
}

export async function findChainPosition(
  walletAddress: string,
  assetId: string,
): Promise<DataPosition | null> {
  try {
    const all = await getPositions(walletAddress);
    return all.find((p) => p.asset === assetId) ?? null;
  } catch (err) {
    logger.warn({ err, walletAddress, assetId }, "findChainPosition failed; treat as null");
    return null;
  }
}
