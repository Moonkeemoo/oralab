/**
 * Coverage tests for decide_exit branches not covered by invariants/QA suites.
 * Each test exercises a specific gate or branch.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../src/decide.js";
import { cfg, makePos, makeSnap, NOW } from "./helpers.js";

describe("decide_exit — gate coverage", () => {
  it("Gate 4: HOLD on UMA proposed", () => {
    const snap = makeSnap({ umaResolutionStatus: "proposed" });
    const intent = decideExit(makePos(), snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 4: HOLD on UMA disputed", () => {
    const snap = makeSnap({ umaResolutionStatus: "disputed" });
    const intent = decideExit(makePos(), snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 4: HOLD on acceptingOrders=false", () => {
    const snap = makeSnap({ acceptingOrders: false });
    const intent = decideExit(makePos(), snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 4: HOLD on status=PENDING", () => {
    const intent = decideExit(makePos({ status: "PENDING" }), makeSnap(), cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 4: HOLD on status=FILLED (transient)", () => {
    const intent = decideExit(makePos({ status: "FILLED" }), makeSnap(), cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 4: HOLD on status=RESOLVED (waiting redeem)", () => {
    const intent = decideExit(makePos({ status: "RESOLVED" }), makeSnap(), cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 7: SL emergency probe at bid+tick (sweepCount=0)", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      sweepCount: 0,
    });
    // -20% pnl → SL emergency (-17%)
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_bid_probe");
    expect(intent.price).toBeCloseTo(0.41, 5);
    expect(intent.gates).toContain("SL-E");
  });

  it("Gate 7: SL emergency FOK at floor when sweepCount >= 2", () => {
    const snap = makeSnap({
      bid: 0.4,
      ask: 0.41,
      mark: 0.4,
      tickSize: 0.01,
      expectedOutcomeValue: 0.5,
    });
    const pos = makePos({
      fillPrice: 0.6,
      shares: 10,
      onChainShares: 10,
      sweepCount: 2,
    });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_fok");
    expect(intent.urgency).toBe(5);
    // floor = max(0.01, 0.5 * 0.3) = 0.15
    expect(intent.price).toBeGreaterThanOrEqual(0.15);
  });

  it("Gate 8: TP at bid+1tick (+20% pnl)", () => {
    const snap = makeSnap({ bid: 0.6, ask: 0.61, mark: 0.6, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      fillTs: NOW - 60_000,
    });
    // +20% pnl → TP exactly at threshold
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_bid_probe");
    expect(intent.gates).toContain("TP");
  });

  it("Gate 9: trail triggers at giveback breach", () => {
    const snap = makeSnap({ bid: 0.55, ask: 0.56, mark: 0.55, tickSize: 0.01 });
    // peak 0.6 → 20% above fill 0.5 (above 15% activation)
    // trailFloor = 0.6 * (1 - 0.05) = 0.57; mark 0.55 < 0.57 → trigger
    const pos = makePos({
      fillPrice: 0.5,
      peakPrice: 0.6,
      trailArmed: true,
      shares: 10,
      onChainShares: 10,
    });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_bid_probe");
    expect(intent.gates).toContain("TRAIL");
  });

  it("Gate 9: trail armed by peak crossing without explicit flag", () => {
    const snap = makeSnap({ bid: 0.55, ask: 0.56, mark: 0.55 });
    // peak >= fill * 1.15 = 0.575 → auto-arms even with trailArmed=false
    const pos = makePos({
      fillPrice: 0.5,
      peakPrice: 0.6,
      trailArmed: false,
      shares: 10,
      onChainShares: 10,
    });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_bid_probe");
  });

  it("Gate 10: SL standard probe at bid+1tick (sweepCount=0)", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.42, tickSize: 0.01 });
    // -16% pnl → SL standard, not emergency. age > 300s required
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      fillTs: NOW - 600_000,
      sweepCount: 0,
    });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_bid_probe");
    expect(intent.gates).toContain("SL");
  });

  it("Gate 10: SL standard aggr at bid-1tick after sweepCount >= 1", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.42, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      fillTs: NOW - 600_000,
      sweepCount: 1,
    });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("sell_bid_aggr");
    expect(intent.price).toBeCloseTo(0.39, 5);
  });

  it("Gate 10: SL holds while position age < min age (anti-noise)", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.42, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      fillTs: NOW - 60_000, // 60s — less than 300s min
    });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("Gate 11: HOLD when no condition triggers (mid-range pnl, no trail)", () => {
    const snap = makeSnap({ bid: 0.5, ask: 0.51, mark: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("buildSell: HOLD when proposed price below floor (M2 short-circuit)", () => {
    // outcomeFloor = max(tick, 0.5 * 0.3) = 0.15. bid+tick=0.05 < floor.
    // SL emergency would fire but floor blocks → HOLD with M2 in gates
    const snap = makeSnap({
      bid: 0.04,
      ask: 0.05,
      mark: 0.04,
      tickSize: 0.01,
      expectedOutcomeValue: 0.5,
    });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates).toContain("INV-M2");
  });
});
