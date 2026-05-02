import type { ExitConfig } from "../src/types/decide.js";
import { DEFAULT_EXIT_CONFIG } from "../src/types/decide.js";
import type { MarketSnapshot } from "../src/types/market.js";
import type { PositionView } from "../src/types/position.js";

export const NOW = 1_777_700_000_000;

export function makeSnap(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    conditionId: "0xtest",
    assetId: "0",
    bid: 0.5,
    ask: 0.51,
    bidSize: 100,
    askSize: 100,
    mark: 0.505,
    markSource: "rest_book",
    markTs: NOW,
    tickSize: 0.01,
    negRisk: false,
    minOrderSize: 5,
    expectedOutcomeValue: 0.5,
    acceptingOrders: true,
    umaResolutionStatus: null,
    resolved: false,
    winningOutcomeIndex: null,
    endDateTs: NOW + 86_400_000,
    fetchedAt: NOW,
    ...overrides,
  };
}

export function makePos(overrides: Partial<PositionView> = {}): PositionView {
  return {
    id: "pos-1",
    userId: 1,
    walletAddress: "0xba462127e57124acf907f00f87543805d9e7ae62",
    conditionId: "0xtest",
    assetId: "0",
    side: "YES",
    status: "OPEN",
    shares: 10,
    onChainShares: 10,
    fillPrice: 0.5,
    peakPrice: 0.5,
    fillTs: NOW - 60_000,
    lastStateChangeTs: NOW - 60_000,
    trailArmed: false,
    sweepCount: 0,
    reconciliationDriftPct: 0,
    sportsHint: null,
    ...overrides,
  };
}

export const cfg: ExitConfig = DEFAULT_EXIT_CONFIG;
