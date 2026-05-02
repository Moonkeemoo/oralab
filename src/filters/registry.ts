import { bidAskSpreadWide } from "./impl/bid_ask_spread_wide.js";
import { convictionGate } from "./impl/conviction_gate.js";
import { drawdownFullStop } from "./impl/drawdown_full_stop.js";
import { hardSafety } from "./impl/hard_safety.js";
import { marketVolume } from "./impl/market_volume.js";
import { maxOpenPositions } from "./impl/max_open_positions.js";
import { priceTooHigh } from "./impl/price_too_high.js";
import { priceTooLow } from "./impl/price_too_low.js";
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
];

const BY_NAME = new Map(FILTERS.map((f) => [f.name, f] as const));

export function getFilter(name: string): Filter | undefined {
  return BY_NAME.get(name);
}

export function listRegisteredFilters(): readonly string[] {
  return [...BY_NAME.keys()];
}

export const filtersRegistry = BY_NAME;
