import type { ExitConfig } from "./decide.js";
import type { MarketMetadata } from "./market.js";
import type { Signal, SignalSource } from "./signal.js";

export type StrategyKind = "whale_follow" | "sports_ws_reactor" | "sports_pre_event";

export type Decision =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "enter";
      readonly side: "YES" | "NO";
      readonly priceCap: number;
      readonly sizeUsdHint: number;
      readonly conviction: number;
    };

export interface StrategyConfig {
  readonly id: string;
  readonly userId: number;
  readonly kind: StrategyKind;
  readonly enabled: boolean;
  readonly params: Record<string, unknown>;
}

export interface Strategy {
  readonly id: string;
  readonly kind: StrategyKind;
  readonly config: StrategyConfig;
  signalSources(): readonly SignalSource[];
  evaluate(signal: Signal, market: MarketMetadata): Promise<Decision>;
  exitConfig(): ExitConfig;
  sizing(decision: Extract<Decision, { kind: "enter" }>, balance: number): number;
}
