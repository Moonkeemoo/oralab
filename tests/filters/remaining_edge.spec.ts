import { describe, expect, it } from "vitest";
import { remainingEdge } from "../../src/filters/impl/remaining_edge.js";
import type { FilterContext } from "../../src/filters/types.js";

const baseCtx = (priceHint: number): FilterContext => ({
  signal: {
    id: "sig-1",
    userId: 1,
    strategyId: "1",
    source: "whale_chain",
    conditionId: "0xcond",
    assetId: "asset-A",
    side: "YES",
    priceHint,
    volumeUsdHint: 100,
    payload: {},
    receivedTs: Date.now(),
  },
  account: {
    userId: 1,
    budgetUsd: 100,
    availableUsd: 50,
    drawdownPct: 0,
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

describe("remaining_edge", () => {
  it("passes at mid prices with ample edge", () => {
    const r = remainingEdge.evaluate(baseCtx(0.4), { minEdgeFrac: 0.20 });
    expect(r.passed).toBe(true);
  });

  it("rejects when remaining edge below threshold", () => {
    const r = remainingEdge.evaluate(baseCtx(0.85), { minEdgeFrac: 0.20 });
    expect(r.passed).toBe(false);
  });

  it("rejects degenerate price ≥ 1", () => {
    const r = remainingEdge.evaluate(baseCtx(1.0), { minEdgeFrac: 0.20 });
    expect(r.passed).toBe(false);
  });
});
