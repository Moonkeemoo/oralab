import { describe, expect, it } from "vitest";
import { entryCooldown } from "../../src/filters/impl/entry_cooldown.js";
import type { FilterContext } from "../../src/filters/types.js";

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

describe("entry_cooldown", () => {
  it("passes when there are no open positions for the asset", () => {
    const r = entryCooldown.evaluate(baseCtx(), { entryCooldownSec: 120 });
    expect(r.passed).toBe(true);
  });

  it("rejects when an open position exists on the same asset", () => {
    const ctx = baseCtx();
    const ctxWithOpen: FilterContext = {
      ...ctx,
      account: {
        ...ctx.account,
        openPositions: [
          { id: 1, conditionId: "0xcond", assetId: "asset-A", entryCostUsd: 10, status: "OPEN" },
        ],
      },
    };
    const r = entryCooldown.evaluate(ctxWithOpen, { entryCooldownSec: 120 });
    expect(r.passed).toBe(false);
  });
});
