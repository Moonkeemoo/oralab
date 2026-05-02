import { describe, expect, it } from "vitest";
import { maxPositionsPerEvent } from "../../src/filters/impl/max_positions_per_event.js";
import type { FilterContext, OpenPositionLite } from "../../src/filters/types.js";

const baseCtx = (openPositions: readonly OpenPositionLite[] = []): FilterContext => ({
  signal: {
    id: "sig-1",
    userId: 1,
    strategyId: "1",
    source: "whale_chain",
    conditionId: "0xevent",
    assetId: "asset-A",
    side: "YES",
    priceHint: 0.5,
    volumeUsdHint: 100,
    payload: {},
    receivedTs: Date.now(),
  },
  account: {
    userId: 1,
    budgetUsd: 100,
    availableUsd: 50,
    drawdownPct: 0,
    openPositions,
    totalExposureUsd: 0,
    cashPnl24hUsd: 0,
  },
  market: {
    conditionId: "0xevent",
    assetId: "asset-A",
    bid: 0.49,
    ask: 0.51,
    mark: 0.5,
    hoursToResolution: 24,
    volumeUsd: 1000,
    liquidityUsd: 1000,
    tickSize: 0.01,
    negRisk: false,
    minOrderSize: 5,
    isSportsMarket: true,
    gameId: "game-1",
  },
  whale: {
    address: "0xwhale",
    tracked: true,
    classification: "INFORMED",
    confidence: 0.8,
    convictionScore: 0.6,
    trustScore: 0.7,
    smScore: 0.6,
    signalAgeSec: 1,
  },
  nowMs: Date.now(),
});

describe("max_positions_per_event", () => {
  it("passes when no positions on the conditionId", () => {
    const r = maxPositionsPerEvent.evaluate(baseCtx(), { maxPerEvent: 3 });
    expect(r.passed).toBe(true);
  });

  it("rejects when at or above cap", () => {
    const r = maxPositionsPerEvent.evaluate(
      baseCtx([
        { id: 1, conditionId: "0xevent", assetId: "x", entryCostUsd: 10, status: "OPEN" },
        { id: 2, conditionId: "0xevent", assetId: "y", entryCostUsd: 10, status: "OPEN" },
        { id: 3, conditionId: "0xevent", assetId: "z", entryCostUsd: 10, status: "OPEN" },
      ]),
      { maxPerEvent: 3 },
    );
    expect(r.passed).toBe(false);
  });

  it("ignores positions on a different conditionId", () => {
    const r = maxPositionsPerEvent.evaluate(
      baseCtx([
        { id: 1, conditionId: "0xother", assetId: "x", entryCostUsd: 10, status: "OPEN" },
        { id: 2, conditionId: "0xother", assetId: "y", entryCostUsd: 10, status: "OPEN" },
      ]),
      { maxPerEvent: 1 },
    );
    expect(r.passed).toBe(true);
  });
});
