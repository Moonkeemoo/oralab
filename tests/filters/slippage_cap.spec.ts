import { describe, expect, it } from "vitest";
import { slippageCap } from "../../src/filters/impl/slippage_cap.js";
import type { FilterContext } from "../../src/filters/types.js";

const baseCtx = (signalPx: number, ask: number): FilterContext => ({
  signal: {
    id: "sig-1",
    userId: 1,
    strategyId: "1",
    source: "whale_chain",
    conditionId: "0xcond",
    assetId: "asset-A",
    side: "YES",
    priceHint: signalPx,
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
    bid: ask - 0.02,
    ask,
    mark: ask - 0.01,
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

describe("slippage_cap", () => {
  it("passes when ask is at or below signal price", () => {
    const r = slippageCap.evaluate(baseCtx(0.5, 0.5), { maxSlippageFrac: 0.10 });
    expect(r.passed).toBe(true);
  });

  it("passes when drift within cap (5% drift, 10% cap)", () => {
    const r = slippageCap.evaluate(baseCtx(0.5, 0.525), { maxSlippageFrac: 0.10 });
    expect(r.passed).toBe(true);
  });

  it("rejects when drift exceeds cap (20% drift, 10% cap)", () => {
    const r = slippageCap.evaluate(baseCtx(0.5, 0.6), { maxSlippageFrac: 0.10 });
    expect(r.passed).toBe(false);
  });

  it("passes when ask data missing (≤0)", () => {
    const r = slippageCap.evaluate(baseCtx(0.5, 0), { maxSlippageFrac: 0.10 });
    expect(r.passed).toBe(true);
  });
});
