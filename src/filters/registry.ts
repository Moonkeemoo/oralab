import { bidAskSpreadWide } from "./impl/bid_ask_spread_wide.js";
import { convictionGate } from "./impl/conviction_gate.js";
import { drawdownFullStop } from "./impl/drawdown_full_stop.js";
import { drawdownMinimal } from "./impl/drawdown_minimal.js";
import { entryCooldown } from "./impl/entry_cooldown.js";
import { exitReentryCooldown } from "./impl/exit_reentry_cooldown.js";
import { hardSafety } from "./impl/hard_safety.js";
import { intradayBinary } from "./impl/intraday_binary.js";
import { marketVolume } from "./impl/market_volume.js";
import { maxOpenPositions } from "./impl/max_open_positions.js";
import { maxPositionsPerEvent } from "./impl/max_positions_per_event.js";
import { postResolution } from "./impl/post_resolution.js";
import { priceCollapsed } from "./impl/price_collapsed.js";
import { priceTooHigh } from "./impl/price_too_high.js";
import { priceTooLow } from "./impl/price_too_low.js";
import { recentRejectCache } from "./impl/recent_reject_cache.js";
import { remainingEdge } from "./impl/remaining_edge.js";
import { slippageCap } from "./impl/slippage_cap.js";
import { smScore } from "./impl/sm_score.js";
import { sportOnly } from "./impl/sport_only.js";
import { staleTrade } from "./impl/stale_trade.js";
import { timeHorizonTooClose } from "./impl/time_horizon_too_close.js";
import { totalExposureCap } from "./impl/total_exposure_cap.js";
import { trustGate } from "./impl/trust_gate.js";
import { whaleSizeFloor } from "./impl/whale_size_floor.js";
import type { Filter } from "./types.js";

/**
 * Filter registry — maps DB `strategy_filters.filter_name` strings to live
 * Filter implementations. Adding a new filter: implement, register here.
 *
 * Order matters at runtime — see pipeline.ts for execution order resolution.
 */
const FILTERS: Filter[] = [
  hardSafety,
  sportOnly,
  whaleSizeFloor,
  priceTooHigh,
  priceTooLow,
  convictionGate,
  trustGate,
  smScore,
  marketVolume,
  bidAskSpreadWide,
  staleTrade,
  timeHorizonTooClose,
  maxOpenPositions,
  drawdownFullStop,
  totalExposureCap,
  entryCooldown,
  exitReentryCooldown,
  intradayBinary,
  postResolution,
  maxPositionsPerEvent,
  recentRejectCache,
  priceCollapsed,
  slippageCap,
  remainingEdge,
  drawdownMinimal,
];

const BY_NAME = new Map(FILTERS.map((f) => [f.name, f] as const));

export function getFilter(name: string): Filter | undefined {
  return BY_NAME.get(name);
}

export function listRegisteredFilters(): readonly string[] {
  return [...BY_NAME.keys()];
}

export const filtersRegistry = BY_NAME;

// ── Filter descriptor catalog (Phase I) ────────────────────────────────
// Static catalog of every filter we plan to support — used by
// /api/filters/registry to render the Strategy tab Filters card with
// grouping + ported badges. Keep in sync with v1 + active impls above.

export type FilterGroup =
  | "hard_safety"
  | "conviction"
  | "wallet_quality"
  | "market_quality"
  | "price_quality"
  | "risk_exposure";

export interface FilterDescriptor {
  name: string;
  group: FilterGroup;
  ported: boolean;
  description: string;
  defaultThreshold?: number | string | null;
  /** Set when the implementation lives under a different filter name (truth in code). */
  aliasOf?: string;
  /** False if the rule is enforced out-of-band (e.g. router pre-check) and not in the per-signal pipeline. */
  pipelineActive?: boolean;
  /** Free-form clarification surfaced in the UI. */
  note?: string;
}

export const FILTER_REGISTRY: readonly FilterDescriptor[] = [
  // Hard Safety (~18 from v1)
  { name: "kill_switch", group: "hard_safety", ported: true, pipelineActive: false, description: "Block all entries when kill switch active", note: "checked by signal_router pre-pipeline" },
  { name: "sell_trade", group: "hard_safety", ported: false, pipelineActive: false, description: "Reject SELL signals (BUY-only mode)", note: "v2 routes never emit SELL signals; not needed in pipeline" },
  { name: "trade_age", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "stale_trade", description: "Reject signals older than MAX_TRADE_AGE_SEC", defaultThreshold: 120 },
  { name: "entry_cooldown", group: "hard_safety", ported: true, pipelineActive: true, description: "Block re-entry within ENTRY_COOLDOWN_S", defaultThreshold: 120 },
  { name: "exit_reentry", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "exit_reentry_cooldown", description: "Block re-entry within EXIT_REENTRY_COOLDOWN_S after a close", defaultThreshold: 600 },
  { name: "price_band", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "price_too_high+price_too_low", description: "Reject if price outside [PRICE_MIN, PRICE_MAX] — split into price_too_high and price_too_low", defaultThreshold: "[0.15, 0.85]" },
  { name: "category", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "sport_only", description: "Block markets not in allowed category list", note: "v2 P1 hardcoded to sports" },
  { name: "intraday_binary", group: "hard_safety", ported: true, pipelineActive: true, description: "Reject intraday-binary + crypto coin-flip markets" },
  { name: "market_resolved", group: "hard_safety", ported: true, pipelineActive: false, description: "Reject resolved/closed markets", note: "checked by signal_router pre-pipeline (market.closed/archived/umaResolutionStatus)" },
  { name: "min_time_to_res", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "time_horizon_too_close", description: "Reject if market resolves too soon" },
  { name: "max_positions", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "max_open_positions", description: "Reject if open_positions >= MAX_OPEN_POSITIONS" },
  { name: "dedup", group: "hard_safety", ported: true, pipelineActive: false, description: "Reject duplicate entry on same market in window", note: "checked by signal_router pre-INSERT (uq_positions_open_per_asset)" },
  { name: "drawdown_full_stop", group: "hard_safety", ported: true, pipelineActive: true, description: "Hard stop if drawdown > DRAWDOWN_STOP_PCT" },
  { name: "total_exposure_cap", group: "hard_safety", ported: true, pipelineActive: true, description: "Reject if open_cost sum > MAX_TOTAL_EXPOSURE_USD" },
  { name: "recent_reject_cache", group: "hard_safety", ported: true, pipelineActive: true, description: "Skip recently rejected tokens for cooldown", defaultThreshold: 60 },
  { name: "min_whale_size", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "whale_size_floor", description: "Reject whale size < MIN_WHALE_SIZE_USD" },
  { name: "post_resolution", group: "hard_safety", ported: true, pipelineActive: true, description: "Block entry after market resolution" },
  { name: "bid_ask_spread", group: "hard_safety", ported: true, pipelineActive: true, aliasOf: "bid_ask_spread_wide", description: "Reject if spread > MAX_BID_ASK_SPREAD_BPS" },
  // Conviction
  { name: "conviction_gate", group: "conviction", ported: true, pipelineActive: true, description: "Gate on conviction score threshold" },
  // Wallet Quality
  { name: "trust_gate", group: "wallet_quality", ported: true, pipelineActive: true, description: "Gate on whale trust_score" },
  { name: "sm_score_gate", group: "wallet_quality", ported: true, pipelineActive: true, aliasOf: "sm_score", description: "Gate on whale sm_score (size escalation)" },
  // Market Quality
  { name: "market_volume", group: "market_quality", ported: true, pipelineActive: true, description: "Reject low-volume markets" },
  // Price Quality
  { name: "price_impact", group: "price_quality", ported: false, pipelineActive: false, description: "Reject orders with high price impact" },
  { name: "slippage", group: "price_quality", ported: true, pipelineActive: true, aliasOf: "slippage_cap", description: "Reject if slippage > threshold", defaultThreshold: 0.10 },
  { name: "price_collapsed", group: "price_quality", ported: true, pipelineActive: true, description: "Reject if price collapsed to 0 or 1" },
  { name: "remaining_edge", group: "price_quality", ported: true, pipelineActive: true, description: "Reject if remaining edge < threshold", defaultThreshold: 0.20 },
  { name: "tp_reachability", group: "price_quality", ported: false, pipelineActive: false, description: "Reject if TP unreachable" },
  // Risk Exposure
  { name: "correlation_cap", group: "risk_exposure", ported: false, pipelineActive: false, description: "Cap exposure for correlated positions" },
  { name: "drawdown_minimal", group: "risk_exposure", ported: true, pipelineActive: true, description: "Minimal drawdown sanity check", defaultThreshold: -0.05 },
  { name: "max_positions_per_event", group: "risk_exposure", ported: true, pipelineActive: true, description: "Cap positions per event/domain" },
  // v2-only additions
  { name: "sport_only", group: "hard_safety", ported: true, pipelineActive: true, description: "Sports-only domain restriction (v2 P1 default)" },
  { name: "price_too_high", group: "price_quality", ported: true, pipelineActive: true, description: "Reject if entry price > PRICE_CEILING (v2)" },
  { name: "budget_exhausted", group: "hard_safety", ported: true, pipelineActive: false, description: "Reject when strategy budget exhausted (v2)", note: "checked by sizer pre-pipeline" },
];
