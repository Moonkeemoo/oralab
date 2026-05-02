import process from "node:process";
import { fetchJson } from "./http.js";

/**
 * data-api client — chain truth for our wallet.
 *
 *   GET /positions?user=WALLET   → current open on-chain positions
 *   GET /activity?user=WALLET    → historical trades
 *
 * Eventual consistency: 5-30s after on-chain fill. Reconciler grace periods
 * (architecture §08) handle this — callers must not panic on a recently-changed
 * position appearing absent.
 *
 * curPrice in /positions is gamma-derived (implied), NOT bid. NEVER use it for
 * exit pricing — see INV-D1 / QA-166.
 */

const DATA_API_URL = process.env["DATA_API_URL"] ?? "https://data-api.polymarket.com";

export interface DataPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

export interface DataActivity {
  asset: string;
  conditionId: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: number;
  transactionHash: string;
  fee: number;
  title: string;
}

export async function getPositions(walletAddress: string): Promise<DataPosition[]> {
  const url = `${DATA_API_URL}/positions?user=${walletAddress}`;
  return await fetchJson<DataPosition[]>(url);
}

export interface ActivityParams {
  readonly limit?: number;
  readonly offset?: number;
  readonly type?: "TRADE" | "REDEEM" | "MERGE";
}

export async function getActivity(
  walletAddress: string,
  params: ActivityParams = {},
): Promise<DataActivity[]> {
  const limit = params.limit ?? 500;
  const offset = params.offset ?? 0;
  const type = params.type ?? "TRADE";
  const url = `${DATA_API_URL}/activity?user=${walletAddress}&type=${type}&limit=${limit}&offset=${offset}`;
  return await fetchJson<DataActivity[]>(url);
}

/**
 * Realized PnL for a market = Σ(SELLs.size×price) − Σ(BUYs.size×price) − fees.
 * Authoritative — never local trades cache (INV-D1).
 */
export function realizedPnlFromActivity(activity: readonly DataActivity[]): number {
  let pnl = 0;
  for (const a of activity) {
    const notional = a.size * a.price;
    pnl += a.side === "SELL" ? notional : -notional;
    pnl -= a.fee;
  }
  return pnl;
}
