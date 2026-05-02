import { describe, expect, it } from "vitest";
import { intradayBinary } from "../../src/filters/impl/intraday_binary.js";
import type { FilterContext } from "../../src/filters/types.js";

const ctxWithTitle = (title: string): FilterContext => ({
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
    payload: { title },
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

describe("intraday_binary", () => {
  it("passes a normal sports market title", () => {
    const r = intradayBinary.evaluate(ctxWithTitle("Lakers vs Celtics — moneyline"), {});
    expect(r.passed).toBe(true);
  });

  it("rejects an intraday-flagged title", () => {
    const r = intradayBinary.evaluate(ctxWithTitle("BTC price intraday move"), {});
    expect(r.passed).toBe(false);
  });

  it("rejects a crypto-binary title", () => {
    const r = intradayBinary.evaluate(ctxWithTitle("Will BTC cross 100k by Friday"), {});
    expect(r.passed).toBe(false);
  });

  it("disabled flag bypasses the filter", () => {
    const r = intradayBinary.evaluate(ctxWithTitle("BTC intraday move"), { enabled: false });
    expect(r.passed).toBe(true);
  });
});
