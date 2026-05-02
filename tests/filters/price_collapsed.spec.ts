import { describe, expect, it } from "vitest";
import { priceCollapsed } from "../../src/filters/impl/price_collapsed.js";
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

describe("price_collapsed", () => {
  it("passes a normal mid-band price", () => {
    const r = priceCollapsed.evaluate(baseCtx(0.5), { minPrice: 0.02, maxPrice: 0.98 });
    expect(r.passed).toBe(true);
  });

  it("rejects when price collapsed near 0", () => {
    const r = priceCollapsed.evaluate(baseCtx(0.01), { minPrice: 0.02, maxPrice: 0.98 });
    expect(r.passed).toBe(false);
  });

  it("rejects when price pinned near 1", () => {
    const r = priceCollapsed.evaluate(baseCtx(0.99), { minPrice: 0.02, maxPrice: 0.98 });
    expect(r.passed).toBe(false);
  });
});
