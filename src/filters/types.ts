/**
 * Filter pipeline types.
 *
 * A filter takes a `FilterContext` (signal + market + account snapshot) and
 * returns either pass or skip-with-reason. The pipeline runs filters in order
 * and short-circuits on the first skip, recording every filter's value into
 * `filter_values` on the resulting Decision (matches v1 format for replay
 * compatibility).
 *
 * Filter logic is PORTED from v1 `core/filters/`, not the code itself.
 */
import type { Signal } from "../types/signal.js";

export interface OpenPositionLite {
  readonly id: number;
  readonly conditionId: string;
  readonly assetId: string;
  readonly entryCostUsd: number;
  readonly status: "PENDING" | "FILLED" | "OPEN" | "EXITING";
}

export interface AccountState {
  readonly userId: number;
  readonly budgetUsd: number;
  readonly availableUsd: number;
  readonly drawdownPct: number;
  readonly openPositions: readonly OpenPositionLite[];
  readonly totalExposureUsd: number;
  readonly cashPnl24hUsd: number;
}

export interface MarketState {
  readonly conditionId: string;
  readonly assetId: string;
  readonly bid: number;
  readonly ask: number;
  readonly mark: number;
  readonly hoursToResolution: number;
  readonly volumeUsd: number;
  readonly liquidityUsd: number;
  readonly tickSize: number;
  readonly negRisk: boolean;
  readonly minOrderSize: number;
}

export interface WhaleState {
  readonly address: string;
  readonly tracked: boolean;
  readonly classification: string;
  readonly confidence: number;
  readonly convictionScore: number;
  readonly trustScore: number;
  readonly smScore: number;
  readonly signalAgeSec: number;
}

export interface FilterContext {
  readonly signal: Signal;
  readonly account: AccountState;
  readonly market: MarketState;
  readonly whale: WhaleState;
  readonly nowMs: number;
}

export interface FilterValue {
  readonly v: number;
  readonly t: number | null;
}

export type FilterResult =
  | { readonly passed: true; readonly value: FilterValue }
  | { readonly passed: false; readonly value: FilterValue; readonly reason: string };

export interface FilterParams {
  readonly [key: string]: number | string | boolean | undefined;
}

export interface Filter {
  readonly name: string;
  readonly description: string;
  evaluate(ctx: FilterContext, params: FilterParams): FilterResult;
}

export const PASS = (value: FilterValue): FilterResult => ({ passed: true, value });
export const SKIP = (value: FilterValue, reason: string): FilterResult => ({
  passed: false,
  value,
  reason,
});
