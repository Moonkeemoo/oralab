import process from "node:process";

export type ExitAction =
  | "hold"
  | "sell_bid_probe"
  | "sell_bid_aggr"
  | "sell_fok"
  | "redeem"
  | "freeze";

export type ExitUrgency = 1 | 2 | 3 | 4 | 5;

export interface ExitIntent {
  readonly action: ExitAction;
  readonly price: number;
  readonly size: number;
  readonly urgency: ExitUrgency;
  readonly reason: string;
  readonly gates: readonly string[];
  readonly snapshotTs: number;
}

export interface ExitConfig {
  readonly stopLoss: number;
  readonly stopLossEmergency: number;
  readonly takeProfit: number;
  readonly trailActivate: number;
  readonly trailStop: number;
  readonly ceilingTpPrice: number;
  readonly minStopLossAgeSeconds: number;
  readonly markStaleSeconds: number;
  readonly postEntryDebounceSeconds: number;
  readonly outcomeFloorMultiplier: number;
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Defaults are v1-ported (-15/-17/+20). Each can be overridden via env for
 * test/verification windows (e.g. tighten thresholds to verify decide_exit →
 * executor → placeSell GTD on real chain without waiting for ±15% moves).
 *
 * Env vars:
 *   EXIT_SL_PCT, EXIT_SL_EMERGENCY_PCT, EXIT_TP_PCT,
 *   EXIT_TRAIL_ACTIVATE_PCT, EXIT_TRAIL_STOP_PCT,
 *   EXIT_CEILING_TP_PRICE, EXIT_MIN_SL_AGE_SEC,
 *   EXIT_MARK_STALE_SEC, EXIT_POST_ENTRY_DEBOUNCE_SEC,
 *   EXIT_OUTCOME_FLOOR_MULT
 */
export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  stopLoss: envNum("EXIT_SL_PCT", -0.15),
  stopLossEmergency: envNum("EXIT_SL_EMERGENCY_PCT", -0.17),
  takeProfit: envNum("EXIT_TP_PCT", 0.2),
  trailActivate: envNum("EXIT_TRAIL_ACTIVATE_PCT", 0.15),
  trailStop: envNum("EXIT_TRAIL_STOP_PCT", 0.05),
  ceilingTpPrice: envNum("EXIT_CEILING_TP_PRICE", 0.97),
  minStopLossAgeSeconds: envNum("EXIT_MIN_SL_AGE_SEC", 300),
  markStaleSeconds: envNum("EXIT_MARK_STALE_SEC", 60),
  postEntryDebounceSeconds: envNum("EXIT_POST_ENTRY_DEBOUNCE_SEC", 5),
  outcomeFloorMultiplier: envNum("EXIT_OUTCOME_FLOOR_MULT", 0.3),
};
