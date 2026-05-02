import { describe, expect, it } from "vitest";
import { sportOnly } from "../../src/filters/impl/sport_only.js";
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
    drawdownPct: 0,
    openPositions: [],
    totalExposureUsd: 0,
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
    liquidityUsd: 10_000,
    tickSize: 0.01,
    negRisk: false,
    minOrderSize: 5,
    isSportsMarket: false,
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
    signalAgeSec: 5,
  },
  nowMs: Date.now(),
};

function ctxWithTitle(title: string): FilterContext {
  return { ...baseCtx, signal: { ...baseCtx.signal, payload: { title } } };
}

describe("sport_only filter", () => {
  it.each([
    "NBA: Lakers vs Mavericks — Lakers ML",
    "NFL Chiefs @ Bills",
    "MLB Yankees vs Red Sox first to score",
    "Soccer EPL: Arsenal vs Chelsea",
    "UFC fight night main event",
    "LoL: Weibo Gaming vs Top Esports (BO3) - LPL Group Ascend",
    "Counter-Strike major spread",
    "Tennis Djokovic moneyline",
  ])("PASS sports title: %s", (title) => {
    const r = sportOnly.evaluate(ctxWithTitle(title), {});
    expect(r.passed).toBe(true);
  });

  it.each([
    "Will Trump win the 2028 election?",
    "BTC $150k by EOY 2026",
    "Fed rate decision December 2026",
    "Will Apple release a new iPhone?",
  ])("SKIP non-sports title: %s", (title) => {
    const r = sportOnly.evaluate(ctxWithTitle(title), {});
    expect(r.passed).toBe(false);
  });

  it("missing title is rejected (cannot classify)", () => {
    const r = sportOnly.evaluate(baseCtx, {});
    expect(r.passed).toBe(false);
  });

  it("PASS when gamma flag isSportsMarket=true even if title is non-sport-keyword", () => {
    const ctx = {
      ...baseCtx,
      market: { ...baseCtx.market, isSportsMarket: true, gameId: "game-123" },
      signal: { ...baseCtx.signal, payload: { title: "obscure proper noun match" } },
    };
    const r = sportOnly.evaluate(ctx, {});
    expect(r.passed).toBe(true);
  });

  it("falls back to title regex when gamma flag is false", () => {
    const ctx = {
      ...baseCtx,
      market: { ...baseCtx.market, isSportsMarket: false, gameId: null },
      signal: { ...baseCtx.signal, payload: { title: "NBA Lakers vs Warriors" } },
    };
    const r = sportOnly.evaluate(ctx, {});
    expect(r.passed).toBe(true);
  });
});
