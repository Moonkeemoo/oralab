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

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  stopLoss: -0.15,
  stopLossEmergency: -0.17,
  takeProfit: 0.2,
  trailActivate: 0.15,
  trailStop: 0.05,
  ceilingTpPrice: 0.97,
  minStopLossAgeSeconds: 300,
  markStaleSeconds: 60,
  postEntryDebounceSeconds: 5,
  outcomeFloorMultiplier: 0.3,
};
