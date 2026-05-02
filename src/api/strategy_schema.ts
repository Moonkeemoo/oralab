export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const okResult: ValidationResult = { ok: true };

export type StrategyParamKey =
  | "budgetUsd"
  | "baseSizeUsd"
  | "maxEntryShares"
  | "defaultConviction"
  | "exitReentryCooldownSec"
  | "ghostWindowSec"
  | "entryCooldownSec"
  | "traderAllocation"
  | "onchainCacheTtlSec"
  | "sportsOnly";

interface NumBounds {
  min: number;
  max: number;
}

const STRATEGY_PARAM_BOUNDS: Partial<Record<StrategyParamKey, NumBounds>> = {
  budgetUsd: { min: 0.01, max: 1_000_000 },
  baseSizeUsd: { min: 0.01, max: 100_000 },
  maxEntryShares: { min: 1, max: 100_000 },
  defaultConviction: { min: 0, max: 1 },
  exitReentryCooldownSec: { min: 0, max: 86_400 },
  ghostWindowSec: { min: 0, max: 86_400 },
  entryCooldownSec: { min: 0, max: 86_400 },
  traderAllocation: { min: 0, max: 1 },
  onchainCacheTtlSec: { min: 0, max: 3600 },
};

export function validateStrategyParam(key: StrategyParamKey, value: unknown): ValidationResult {
  if (key === "sportsOnly") {
    if (typeof value !== "boolean") return { ok: false, reason: "must be boolean" };
    return okResult;
  }
  const bounds = STRATEGY_PARAM_BOUNDS[key];
  if (!bounds) return { ok: false, reason: `unknown strategy param key: ${key}` };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "must be a finite number" };
  }
  if (value < bounds.min) return { ok: false, reason: `must be ≥ ${bounds.min} (positive)` };
  if (value > bounds.max) return { ok: false, reason: `must be ≤ ${bounds.max}` };
  return okResult;
}

export type ExitConfigKey =
  | "stopLoss"
  | "stopLossEmergency"
  | "takeProfit"
  | "trailActivate"
  | "trailStop"
  | "ceilingTpPrice"
  | "minStopLossAgeSeconds"
  | "markStaleSeconds"
  | "postEntryDebounceSeconds"
  | "outcomeFloorMultiplier";

const EXIT_BOUNDS: Record<ExitConfigKey, NumBounds> = {
  stopLoss: { min: -0.99, max: 0 },
  stopLossEmergency: { min: -0.99, max: 0 },
  takeProfit: { min: 0, max: 1.0 },
  trailActivate: { min: 0, max: 1.0 },
  trailStop: { min: 0, max: 1.0 },
  ceilingTpPrice: { min: 0.01, max: 0.999 },
  minStopLossAgeSeconds: { min: 0, max: 86_400 },
  markStaleSeconds: { min: 1, max: 3600 },
  postEntryDebounceSeconds: { min: 0, max: 600 },
  outcomeFloorMultiplier: { min: 0, max: 2 },
};

export function validateExitConfigKey(key: ExitConfigKey, value: unknown): ValidationResult {
  const bounds = EXIT_BOUNDS[key];
  if (!bounds) return { ok: false, reason: `unknown exit_config key: ${key}` };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "must be a finite number" };
  }
  if (value < bounds.min) return { ok: false, reason: `must be ≥ ${bounds.min}` };
  if (value > bounds.max) return { ok: false, reason: `must be ≤ ${bounds.max}` };
  return okResult;
}
