import { describe, expect, it } from "vitest";
import { drawdownMinimal } from "../../src/filters/impl/drawdown_minimal.js";
import type { FilterContext } from "../../src/filters/types.js";

const baseCtx = (drawdownPct: number): FilterContext => ({
  signal: {
    id: "sig-1",
    userId: 1,
    strategyId: "1",
    source: "whale_chain",
    conditionId: "0xcond",
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
    drawdownPct,
    openPositions: [],
    totalExposureUsd: 0,
    cashPnl24hUsd: 0,
  },
  market: {
    conditionId: "0xcond",
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
    gameId: null,
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

describe("drawdown_minimal", () => {
  it("passes at flat PnL", () => {
    const r = drawdownMinimal.evaluate(baseCtx(0), { minDrawdownPct: -0.05 });
    expect(r.passed).toBe(true);
  });

  it("passes with mild drawdown above threshold (-2% > -5%)", () => {
    const r = drawdownMinimal.evaluate(baseCtx(-0.02), { minDrawdownPct: -0.05 });
    expect(r.passed).toBe(true);
  });

  it("rejects with drawdown below threshold (-10% < -5%)", () => {
    const r = drawdownMinimal.evaluate(baseCtx(-0.10), { minDrawdownPct: -0.05 });
    expect(r.passed).toBe(false);
  });
});
