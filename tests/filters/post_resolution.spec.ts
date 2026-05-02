import { describe, expect, it } from "vitest";
import { postResolution } from "../../src/filters/impl/post_resolution.js";
import type { FilterContext } from "../../src/filters/types.js";

const NOW = 1_700_000_000_000;

const ctxWith = (payload: Record<string, unknown>): FilterContext => ({
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
    payload,
    receivedTs: NOW,
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
  nowMs: NOW,
});

describe("post_resolution", () => {
  it("passes when no end date", () => {
    const r = postResolution.evaluate(ctxWith({}), {});
    expect(r.passed).toBe(true);
  });

  it("passes when end date is in the future", () => {
    const future = new Date(NOW + 7 * 24 * 3600 * 1000).toISOString();
    const r = postResolution.evaluate(ctxWith({ endDate: future }), {});
    expect(r.passed).toBe(true);
  });

  it("rejects when end date is in the past", () => {
    const past = new Date(NOW - 24 * 3600 * 1000).toISOString();
    const r = postResolution.evaluate(ctxWith({ endDate: past }), {});
    expect(r.passed).toBe(false);
  });

  it("passes on unparseable end date (defensive)", () => {
    const r = postResolution.evaluate(ctxWith({ endDate: "not-a-date" }), {});
    expect(r.passed).toBe(true);
  });
});
