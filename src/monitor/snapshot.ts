import { getBookTop } from "../api/book.js";
import { type DataPosition, getPositions } from "../api/data.js";
import { getMarketByTokenId } from "../api/gamma.js";
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

const BOOK_TTL_MS = 3_000;
const GAMMA_TTL_MS = 30_000; // gamma metadata changes rarely

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
  const [book, gamma] = await Promise.all([cachedBookTop(assetId), cachedGamma(assetId)]);

  const expectedOutcomeValue = expectedOutcomeForSide(gamma.outcomePricesParsed, side);
  const mark = (book.bid + book.ask) / 2;
  const winningOutcomeIndex =
    gamma.umaResolutionStatus === "resolved"
      ? gamma.outcomePricesParsed.indexOf(Math.max(...gamma.outcomePricesParsed))
      : null;

  return {
    conditionId,
    assetId,
    bid: book.bid,
    ask: book.ask,
    bidSize: book.bidSize,
    askSize: book.askSize,
    mark,
    markSource: "rest_book",
    markTs: book.timestampMs > 0 ? book.timestampMs : Date.now(),
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
