import { describe, expect, it } from "vitest";
import { decideExit } from "../src/decide.js";
import { DEFAULT_EXIT_CONFIG } from "../src/types/decide.js";
import type { MarketSnapshot } from "../src/types/market.js";
import type { PositionView } from "../src/types/position.js";

const baseSnap: MarketSnapshot = {
  conditionId: "0xtest",
  assetId: "0",
  bid: 0.5,
  ask: 0.51,
  bidSize: 100,
  askSize: 100,
  mark: 0.505,
  markSource: "rest_book",
  markTs: Date.now(),
  tickSize: 0.01,
  negRisk: false,
  minOrderSize: 5,
  expectedOutcomeValue: 0.5,
  acceptingOrders: true,
  umaResolutionStatus: null,
  resolved: false,
  winningOutcomeIndex: null,
  endDateTs: Date.now() + 86400_000,
  fetchedAt: Date.now(),
};

const basePos: PositionView = {
  id: "pos-1",
  userId: 1,
  walletAddress: "0xba462127e57124acf907f00f87543805d9e7ae62",
  conditionId: "0xtest",
  assetId: "0",
  side: "YES",
  status: "OPEN",
  shares: 10,
  fillPrice: 0.5,
  peakPrice: 0.5,
  fillTs: Date.now() - 60_000,
  lastStateChangeTs: Date.now() - 60_000,
  trailArmed: false,
  sweepCount: 0,
};

describe("decideExit — Day 1 placeholder", () => {
  it("throws until implemented (red phase TDD)", () => {
    expect(() => decideExit(basePos, baseSnap, DEFAULT_EXIT_CONFIG)).toThrow(/not yet implemented/);
  });
});
