import process from "node:process";
import { fetchJson } from "./http.js";

/**
 * gamma-api client — Polymarket market metadata.
 *
 *   outcomePrices, outcomes, clobTokenIds are JSON-encoded strings → JSON.parse
 *   negRisk MUST be sourced from here (never assumed) — wrong contract = order
 *   rejection (INV-D1, see POLYMARKET_API.md gotchas).
 *   gameId / sportsMarketType present iff this is a sports market — better
 *   sport-only signal than title-regex.
 */

const GAMMA_API_URL = process.env["GAMMA_API_URL"] ?? "https://gamma-api.polymarket.com";

interface GammaMarketRaw {
  question: string;
  slug: string;
  conditionId: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  umaResolutionStatus: string | null;
  endDate: string;
  outcomePrices: string;
  outcomes: string;
  clobTokenIds: string;
  orderPriceMinTickSize: number;
  orderMinSize: number;
  makerBaseFee: number;
  takerBaseFee: number;
  negRisk: boolean;
  liquidity: number;
  volume: number;
  gameId?: string | null;
  sportsMarketType?: string | null;
}

export interface GammaToken {
  readonly tokenId: string;
  readonly outcome: string;
}

export interface GammaMarket {
  readonly question: string;
  readonly slug: string;
  readonly conditionId: string;
  readonly active: boolean;
  readonly closed: boolean;
  readonly archived: boolean;
  readonly acceptingOrders: boolean;
  readonly enableOrderBook: boolean;
  readonly umaResolutionStatus: string | null;
  readonly endDate: string;
  readonly outcomePricesParsed: number[];
  readonly outcomesParsed: string[];
  readonly tokens: readonly GammaToken[];
  readonly orderPriceMinTickSize: number;
  readonly orderMinSize: number;
  readonly makerBaseFee: number;
  readonly takerBaseFee: number;
  readonly negRisk: boolean;
  readonly liquidity: number;
  readonly volume: number;
  readonly gameId: string | null;
  readonly sportsMarketType: string | null;
  readonly isSportsMarket: boolean;
}

function parseJsonArr(s: string): unknown[] {
  if (!s) return [];
  try {
    return JSON.parse(s) as unknown[];
  } catch {
    return [];
  }
}

function parseGammaMarket(m: GammaMarketRaw): GammaMarket {
  const tokenIds = parseJsonArr(m.clobTokenIds).map(String);
  const outcomes = parseJsonArr(m.outcomes).map(String);
  const tokens: GammaToken[] = tokenIds.map((tokenId, i) => ({
    tokenId,
    outcome: outcomes[i] ?? "",
  }));
  const gameId = m.gameId ?? null;
  const sportsMarketType = m.sportsMarketType ?? null;
  return {
    question: m.question,
    slug: m.slug,
    conditionId: m.conditionId,
    active: m.active,
    closed: m.closed,
    archived: m.archived,
    acceptingOrders: m.acceptingOrders,
    enableOrderBook: m.enableOrderBook,
    umaResolutionStatus: m.umaResolutionStatus,
    endDate: m.endDate,
    outcomePricesParsed: parseJsonArr(m.outcomePrices).map(Number),
    outcomesParsed: outcomes,
    tokens,
    orderPriceMinTickSize: m.orderPriceMinTickSize,
    orderMinSize: m.orderMinSize,
    makerBaseFee: m.makerBaseFee,
    takerBaseFee: m.takerBaseFee,
    negRisk: m.negRisk,
    liquidity: m.liquidity,
    volume: m.volume,
    gameId,
    sportsMarketType,
    isSportsMarket: gameId !== null || sportsMarketType !== null,
  };
}

export async function getMarketByTokenId(tokenId: string): Promise<GammaMarket | null> {
  // Default gamma behavior is closed=false filter — exactly what we want for
  // entry: an "open and tradeable" market. Markets returning null here are
  // either non-existent OR closed/resolved (both fine to skip).
  const url = `${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`;
  const arr = await fetchJson<GammaMarketRaw[]>(url);
  const first = arr[0];
  if (!first) return null;
  return parseGammaMarket(first);
}

export async function getMarketByConditionId(conditionId: string): Promise<GammaMarket | null> {
  const url = `${GAMMA_API_URL}/markets?condition_ids=${conditionId}`;
  const arr = await fetchJson<GammaMarketRaw[]>(url);
  const first = arr[0];
  if (!first) return null;
  return parseGammaMarket(first);
}
