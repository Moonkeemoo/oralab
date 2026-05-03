import { type GammaMarket, getMarketByTokenId } from "./gamma.js";
import { logger } from "../obs/logger.js";

/**
 * Per-asset gamma metadata cache. Mini App position/history endpoints render
 * many rows per request, often sharing markets — fetching once per asset per
 * 60s window keeps gamma load bounded. Negative results are cached briefly
 * (15s) so resolved/closed markets don't get re-fetched on every poll.
 */
interface CacheEntry {
  market: GammaMarket | null;
  fetchedAt: number;
}

const TTL_HIT_MS = 60_000;
const TTL_MISS_MS = 15_000;
const cache = new Map<string, CacheEntry>();

export async function getMarketCached(assetId: string): Promise<GammaMarket | null> {
  const now = Date.now();
  const hit = cache.get(assetId);
  if (hit) {
    const age = now - hit.fetchedAt;
    if (hit.market && age < TTL_HIT_MS) return hit.market;
    if (!hit.market && age < TTL_MISS_MS) return null;
  }
  try {
    const market = await getMarketByTokenId(assetId);
    cache.set(assetId, { market, fetchedAt: now });
    return market;
  } catch (err) {
    logger.warn(
      { component: "market_enrich", assetId, err: (err as Error).message },
      "gamma fetch failed, serving stale or null",
    );
    if (hit) return hit.market;
    cache.set(assetId, { market: null, fetchedAt: now });
    return null;
  }
}

export async function getMarketsCachedBatch(
  assetIds: readonly string[],
): Promise<Map<string, GammaMarket | null>> {
  const out = new Map<string, GammaMarket | null>();
  const unique = Array.from(new Set(assetIds));
  await Promise.all(
    unique.map(async (id) => {
      out.set(id, await getMarketCached(id));
    }),
  );
  return out;
}

/**
 * Map position.side ("YES" / "NO") + gamma outcomes[] → human-readable team /
 * outcome name. Sports markets list outcomes like ["Team A", "Team B"]; binary
 * markets keep ["Yes", "No"]. side=YES is index 0, side=NO is index 1.
 */
export function outcomeNameForSide(market: GammaMarket | null, side: string): string {
  if (!market) return side;
  const idx = side.toUpperCase() === "YES" ? 0 : 1;
  const name = market.outcomesParsed[idx];
  if (!name) return side;
  return name;
}

/**
 * Convert market.endDate vs now into a short human label:
 *   future: "in 2h", "in 3d"
 *   past (still active): "overdue 4h"
 *   resolved (closed=true): "resolved 18h ago"
 */
export function resolvesText(market: GammaMarket | null, now: number = Date.now()): string {
  if (!market) return "—";
  const endMs = Date.parse(market.endDate);
  if (!Number.isFinite(endMs)) return market.closed ? "resolved" : "open";
  const diff = endMs - now;
  if (market.closed) {
    const ago = Math.max(0, -diff);
    return `resolved ${humanDuration(ago)} ago`;
  }
  if (diff < 0) {
    return `overdue ${humanDuration(-diff)}`;
  }
  return `in ${humanDuration(diff)}`;
}

function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Downsample an array of numbers to roughly `target` evenly-spaced points.
 * Used for sparkline data where we want consistent visual density regardless
 * of how many decisions a position accumulated.
 */
export function downsample(values: readonly number[], target: number): number[] {
  if (values.length <= target) return values.slice();
  const out: number[] = [];
  const step = (values.length - 1) / (target - 1);
  for (let i = 0; i < target; i += 1) {
    const idx = Math.round(i * step);
    const v = values[idx];
    if (v != null) out.push(v);
  }
  return out;
}

/**
 * Map a raw close_reason string to a UI-friendly label + emoji icon.
 * Unknown reasons fall back to the raw string with a neutral dot.
 */
export interface ExitReasonRender {
  label: string;
  icon: string;
  family: ExitFamily;
}

export type ExitFamily =
  | "tp"
  | "sl_standard"
  | "sl_emergency"
  | "trail"
  | "manual"
  | "timeout"
  | "external"
  | "price_resolved"
  | "other";

const REASON_MAP: Record<string, ExitReasonRender> = {
  // TP family
  tp: { label: "TP", icon: "🟢", family: "tp" },
  take_profit: { label: "TP", icon: "🟢", family: "tp" },
  ceiling_tp: { label: "Ceiling TP", icon: "🟢", family: "tp" },
  // SL family
  sl: { label: "SL", icon: "🔴", family: "sl_standard" },
  stop_loss: { label: "SL", icon: "🔴", family: "sl_standard" },
  sl_standard: { label: "SL", icon: "🔴", family: "sl_standard" },
  sl_emergency: { label: "Emergency SL", icon: "🔴", family: "sl_emergency" },
  // Trail
  trail_stop: { label: "Trail", icon: "📉", family: "trail" },
  // Manual
  manual_exit: { label: "Manual", icon: "✋", family: "manual" },
  manual_exit_all_after_kill: { label: "Manual (kill)", icon: "✋", family: "manual" },
  manual_after_kill_test_ws: { label: "Manual", icon: "✋", family: "manual" },
  manual_freeze: { label: "Frozen", icon: "❄", family: "manual" },
  // Timeout
  timeout: { label: "Timeout", icon: "⏰", family: "timeout" },
  dry_overnight_purge_frozen: { label: "Overnight purge", icon: "⏰", family: "timeout" },
  // External
  external_redeem: { label: "External", icon: "🎮", family: "external" },
  // Price-resolved
  price_resolved: { label: "Price resolv", icon: "❄", family: "price_resolved" },
  resolved: { label: "Resolved", icon: "❄", family: "price_resolved" },
  // Chain-confirmed sells (DRY simulator + real)
  dry_simulated_sell_fill: { label: "Sold (sim)", icon: "🟢", family: "other" },
  chain_sell_filled: { label: "Sold", icon: "🟢", family: "other" },
  sell_filled_chain_lag: { label: "Sold (lag)", icon: "🟢", family: "other" },
};

export function renderExitReason(reason: string | null | undefined): ExitReasonRender {
  if (!reason) return { label: "—", icon: "·", family: "other" };
  const hit = REASON_MAP[reason];
  if (hit) return hit;
  return { label: reason, icon: "·", family: "other" };
}

export const TP_FAMILIES: readonly ExitFamily[] = ["tp"];
export const SL_FAMILIES: readonly ExitFamily[] = ["sl_standard", "sl_emergency"];
