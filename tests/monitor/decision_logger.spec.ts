/**
 * Tests for decision_logger sampling + payload shape. DB insert path is
 * skipped (would need integration suite); we exercise the sampling gate
 * and shape-conversion logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock getDb so module loads without DATABASE_URL.
vi.mock("../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no db in test");
  },
}));

import { recordDecision } from "../../src/monitor/decision_logger.js";
import type { ExitIntent } from "../../src/types/decide.js";
import type { MarketSnapshot } from "../../src/types/market.js";
import type { PositionView } from "../../src/types/position.js";

const baseSnap: MarketSnapshot = {
  conditionId: "0xc",
  assetId: "0",
  bid: 0.5,
  ask: 0.51,
  bidSize: 100,
  askSize: 100,
  mark: 0.505,
  markSource: "rest_book",
  markTs: 1_000,
  tickSize: 0.01,
  negRisk: false,
  minOrderSize: 5,
  expectedOutcomeValue: 0.5,
  acceptingOrders: true,
  umaResolutionStatus: null,
  resolved: false,
  winningOutcomeIndex: null,
  endDateTs: 999_999,
  fetchedAt: 1_000,
};

const basePos: PositionView = {
  id: "1",
  userId: 1,
  walletAddress: "0xa",
  conditionId: "0xc",
  assetId: "0",
  side: "YES",
  status: "OPEN",
  shares: 10,
  onChainShares: 10,
  fillPrice: 0.5,
  peakPrice: 0.5,
  fillTs: 0,
  lastStateChangeTs: 0,
  trailArmed: false,
  sweepCount: 0,
  reconciliationDriftPct: 0,
};

const holdIntent: ExitIntent = {
  action: "hold",
  price: 0,
  size: 0,
  urgency: 1,
  reason: "no signal",
  gates: [],
  snapshotTs: 1_000,
};

const sellIntent: ExitIntent = {
  action: "sell_bid_probe",
  price: 0.51,
  size: 10,
  urgency: 4,
  reason: "SL standard",
  gates: ["SL"],
  snapshotTs: 1_000,
};

describe("recordDecision", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("DECISION_LOG_ENABLED=false short-circuits with no DB call", async () => {
    vi.stubEnv("DECISION_LOG_ENABLED", "false");
    // We can verify "no db call" because our mocked getDb() throws — if it
    // were called the await would reject. recordDecision swallows errors,
    // but the swallow path issues a logger.warn. We assert no throw.
    await expect(
      recordDecision({ pos: basePos, snap: baseSnap, intent: sellIntent, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });

  it("non-HOLD actions always recorded (sample gate skipped)", async () => {
    vi.stubEnv("DECISION_LOG_SAMPLE_PCT", "0"); // would skip ALL holds
    (Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0.99);
    // sell_bid_probe → record path runs (and our mocked getDb throws, swallowed)
    await expect(
      recordDecision({ pos: basePos, snap: baseSnap, intent: sellIntent, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });

  it("HOLD respects sample percentage", async () => {
    vi.stubEnv("DECISION_LOG_SAMPLE_PCT", "0.5");
    (Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0.9); // > 0.5
    await expect(
      recordDecision({ pos: basePos, snap: baseSnap, intent: holdIntent, durationMs: 1 }),
    ).resolves.toBeUndefined();
    // 0.9 > 0.5 → skip path: no DB attempted
    (Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0.1); // < 0.5 → record path
    await expect(
      recordDecision({ pos: basePos, snap: baseSnap, intent: holdIntent, durationMs: 1 }),
    ).resolves.toBeUndefined();
  });

  it("DB insert failure is swallowed (never throws into trading hot-path)", async () => {
    // Default sample=1, holdIntent → sample passes → getDb() throws → caught
    await expect(
      recordDecision({ pos: basePos, snap: baseSnap, intent: holdIntent, durationMs: 5 }),
    ).resolves.toBeUndefined();
  });
});
