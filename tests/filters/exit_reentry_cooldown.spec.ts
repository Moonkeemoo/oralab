import { describe, expect, it } from "vitest";
import { exitReentryCooldown } from "../../src/filters/impl/exit_reentry_cooldown.js";
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
    recentlyClosedAssets: [],
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

describe("exit_reentry_cooldown", () => {
  it("passes when there are no recently closed positions for the asset", () => {
    const r = exitReentryCooldown.evaluate(baseCtx(), { exitReentryCooldownSec: 600 });
    expect(r.passed).toBe(true);
  });

  it("rejects when the same asset was closed within the cooldown window", () => {
    const ctx = baseCtx();
    const ctxWithClosed: FilterContext = {
      ...ctx,
      account: {
        ...ctx.account,
        recentlyClosedAssets: [{ assetId: "asset-A", closedAtTs: NOW - 60_000 }],
      },
    };
    const r = exitReentryCooldown.evaluate(ctxWithClosed, { exitReentryCooldownSec: 600 });
    expect(r.passed).toBe(false);
  });

  it("passes when the close happened before the cooldown window", () => {
    const ctx = baseCtx();
    const ctxWithOld: FilterContext = {
      ...ctx,
      account: {
        ...ctx.account,
        recentlyClosedAssets: [{ assetId: "asset-A", closedAtTs: NOW - 10 * 60 * 1000 }],
      },
    };
    const r = exitReentryCooldown.evaluate(ctxWithOld, { exitReentryCooldownSec: 600 });
    expect(r.passed).toBe(true);
  });
});
