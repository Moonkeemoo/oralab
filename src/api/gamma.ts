import process from "node:process";
import { fetchJson } from "./http.js";

/**
 * gamma-api client — Polymarket market metadata (negRisk, tickSize, fees,
 * outcome prices, accepting orders, UMA resolution status).
 *
 *   outcomePrices is JSON-encoded string ("[\"0.95\", \"0.05\"]") → JSON.parse
 *   negRisk MUST be sourced from here (never assumed) — wrong contract = order
 *   rejection (INV-D1, see POLYMARKET_API.md gotchas).
 */

const GAMMA_API_URL = process.env["GAMMA_API_URL"] ?? "https://gamma-api.polymarket.com";

export interface GammaToken {
  token_id: string;
  outcome: string;
}

export interface GammaMarketRaw {
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
  tokens: GammaToken[];
  orderPriceMinTickSize: number;
  orderMinSize: number;
  maker_base_fee: number;
  taker_base_fee: number;
  negRisk: boolean;
  liquidity: number;
  volume: number;
}

export interface GammaMarket extends Omit<GammaMarketRaw, "outcomePrices" | "outcomes"> {
  outcomePricesParsed: number[];
  outcomesParsed: string[];
}

function parseGammaMarket(m: GammaMarketRaw): GammaMarket {
  return {
    ...m,
    outcomePricesParsed: (JSON.parse(m.outcomePrices) as string[]).map(Number),
    outcomesParsed: JSON.parse(m.outcomes) as string[],
  };
}

export async function getMarketByTokenId(tokenId: string): Promise<GammaMarket | null> {
  const url = `${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`;
  const arr = await fetchJson<GammaMarketRaw[]>(url);
  const first = arr[0];
  if (!first) return null;
  return parseGammaMarket(first);
}

export async function getMarketByConditionId(conditionId: string): Promise<GammaMarket | null> {
  const url = `${GAMMA_API_URL}/markets/${conditionId}`;
  const m = await fetchJson<GammaMarketRaw>(url);
  return parseGammaMarket(m);
}
