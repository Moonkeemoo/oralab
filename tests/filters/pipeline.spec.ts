import { describe, expect, it } from "vitest";
import { runPipeline } from "../../src/filters/pipeline.js";
import type { FilterContext } from "../../src/filters/types.js";

const baseCtx: FilterContext = {
  signal: {
    id: "sig-1",
    userId: 1,
    strategyId: "1",
    source: "whale_chain",
    conditionId: "0xtest",
    assetId: "0",
    side: "YES",
    priceHint: 0.5,
    volumeUsdHint: 200,
    payload: {},
    receivedTs: Date.now(),
  },
  account: {
    userId: 1,
    budgetUsd: 100,
    availableUsd: 50,
    drawdownPct: 0.05,
    openPositions: [],
    totalExposureUsd: 25,
    cashPnl24hUsd: 0,
  },
  market: {
    conditionId: "0xtest",
    assetId: "0",
    bid: 0.49,
    ask: 0.51,
    mark: 0.5,
    hoursToResolution: 24,
    volumeUsd: 50_000,
    liquidityUsd: 8_000,
    tickSize: 0.01,
    negRisk: false,
    minOrderSize: 5,
  },
  whale: {
    address: "0xwhale",
    tracked: true,
    classification: "INFORMED",
    confidence: 0.8,
    convictionScore: 0.6,
    trustScore: 0.7,
    smScore: 0.6,
    signalAgeSec: 5,
  },
  nowMs: Date.now(),
};

describe("filter pipeline", () => {
  it("passes when no filter rejects (happy path)", () => {
    const r = runPipeline(baseCtx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "whale_size_floor", enabled: true, params: { minWhaleVolumeUsd: 50 } },
      { name: "price_too_low", enabled: true, params: { minPrice: 0.05 } },
      { name: "max_open_positions", enabled: true, params: { max: 5 } },
    ]);
    expect(r.passed).toBe(true);
    expect(r.skipReason).toBeNull();
    expect(Object.keys(r.filterValues).length).toBe(4);
  });

  it("short-circuits on first skip + records value", () => {
    const r = runPipeline(baseCtx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "whale_size_floor", enabled: true, params: { minWhaleVolumeUsd: 1_000 } },
      { name: "price_too_low", enabled: true, params: { minPrice: 0.05 } },
    ]);
    expect(r.passed).toBe(false);
    expect(r.skipReason).toBe("whale_size_floor");
    expect(r.filterValues["whale_size_floor"]).toEqual({ v: 200, t: 1_000 });
    expect(r.filterValues).not.toHaveProperty("price_too_low"); // short-circuited
  });

  it("hard_safety always runs FIRST regardless of registration order", () => {
    const ctx: FilterContext = { ...baseCtx, account: { ...baseCtx.account, availableUsd: 0 } };
    const r = runPipeline(ctx, [
      { name: "whale_size_floor", enabled: true, params: {} },
      { name: "hard_safety", enabled: true, params: {} },
    ]);
    expect(r.skipReason).toBe("hard_safety");
    expect(r.evaluatedCount).toBe(1);
  });

  it("disabled filters are skipped", () => {
    const r = runPipeline(baseCtx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "whale_size_floor", enabled: false, params: { minWhaleVolumeUsd: 1_000 } },
    ]);
    expect(r.passed).toBe(true);
    expect(r.filterValues).not.toHaveProperty("whale_size_floor");
  });

  it("unregistered filter logs warning + treats as pass (forward-compat)", () => {
    const r = runPipeline(baseCtx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "future_filter_xyz", enabled: true, params: {} },
    ]);
    expect(r.passed).toBe(true);
    expect(r.evaluatedCount).toBe(1);
  });
});

describe("individual filter behaviors", () => {
  it("price_too_high rejects entry above ceiling", () => {
    const ctx: FilterContext = { ...baseCtx, signal: { ...baseCtx.signal, priceHint: 0.95 } };
    const r = runPipeline(ctx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "price_too_high", enabled: true, params: { maxPrice: 0.9 } },
    ]);
    expect(r.skipReason).toBe("price_too_high");
  });

  it("max_open_positions skips at cap regardless of enabled position kinds", () => {
    const ctx: FilterContext = {
      ...baseCtx,
      account: {
        ...baseCtx.account,
        openPositions: [
          { id: 1, conditionId: "a", assetId: "1", entryCostUsd: 10, status: "OPEN" },
          { id: 2, conditionId: "b", assetId: "2", entryCostUsd: 10, status: "OPEN" },
          { id: 3, conditionId: "c", assetId: "3", entryCostUsd: 10, status: "EXITING" },
        ],
      },
    };
    const r = runPipeline(ctx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "max_open_positions", enabled: true, params: { max: 3 } },
    ]);
    expect(r.skipReason).toBe("max_open_positions");
    expect(r.filterValues["max_open_positions"]).toEqual({ v: 3, t: 3 });
  });

  it("drawdown_full_stop halts at threshold", () => {
    const ctx: FilterContext = {
      ...baseCtx,
      account: { ...baseCtx.account, drawdownPct: 0.4 },
    };
    const r = runPipeline(ctx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "drawdown_full_stop", enabled: true, params: { drawdownPctFullStop: 0.35 } },
    ]);
    expect(r.skipReason).toBe("drawdown_full_stop");
  });

  it("bid_ask_spread_wide rejects 60% spread", () => {
    const ctx: FilterContext = {
      ...baseCtx,
      market: { ...baseCtx.market, bid: 0.2, ask: 0.8 }, // mid=0.5, spread=0.6 → 120%
    };
    const r = runPipeline(ctx, [
      { name: "hard_safety", enabled: true, params: {} },
      { name: "bid_ask_spread_wide", enabled: true, params: { maxSpreadPct: 0.15 } },
    ]);
    expect(r.skipReason).toBe("bid_ask_spread_wide");
  });

  it("hard_safety blocks dead orderbook (bid=0)", () => {
    const ctx: FilterContext = {
      ...baseCtx,
      market: { ...baseCtx.market, bid: 0, ask: 0.99 },
    };
    const r = runPipeline(ctx, [{ name: "hard_safety", enabled: true, params: {} }]);
    expect(r.skipReason).toBe("hard_safety");
  });
});
