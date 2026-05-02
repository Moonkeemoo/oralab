import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRecentRejectCache,
  recentRejectCache,
  recordRecentReject,
} from "../../src/filters/impl/recent_reject_cache.js";
import type { FilterContext } from "../../src/filters/types.js";

const NOW = 1_700_000_000_000;

const baseCtx = (): FilterContext => ({
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

describe("recent_reject_cache", () => {
  beforeEach(() => __resetRecentRejectCache());

  it("passes when no recent rejection is recorded for the asset", () => {
    const r = recentRejectCache.evaluate(baseCtx(), { cooldownSec: 60 });
    expect(r.passed).toBe(true);
  });

  it("rejects when asset was just recorded within cooldown", () => {
    recordRecentReject("asset-A", NOW - 5_000);
    const r = recentRejectCache.evaluate(baseCtx(), { cooldownSec: 60 });
    expect(r.passed).toBe(false);
  });

  it("passes again after cooldown elapsed (and evicts entry)", () => {
    recordRecentReject("asset-A", NOW - 120_000);
    const r = recentRejectCache.evaluate(baseCtx(), { cooldownSec: 60 });
    expect(r.passed).toBe(true);
  });
});
