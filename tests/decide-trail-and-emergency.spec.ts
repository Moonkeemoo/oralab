/**
 * Scenario coverage for trail giveback (P1.D) and SL emergency sell_fok (P1.E).
 *
 * These two paths are documented as "NOT yet LIVE-verified" in
 * docs/BULLETPROOF.md because they require natural market conditions that
 * we can't force during a verification window:
 *
 *   - trail giveback: needs price to rise +15% above fillPrice (arming
 *     threshold), then drop 5% from peak — measured in real time
 *   - SL emergency sell_fok: needs standard SL bid-1tick aggr to fail to
 *     fill twice in a row (sweep_count >= 2) on an illiquid book
 *
 * Synthetic scenarios in this file exercise the full state-progression that
 * a 2 Hz PositionMonitor would feed into decide_exit: each tick advances
 * peakPrice and sweepCount as the executor would, and we assert the
 * expected ExitIntent at each stage.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../src/decide.js";
import { cfg, makePos, makeSnap, NOW } from "./helpers.js";

describe("Trail giveback — full price arc (P1.D synthetic LIVE replacement)", () => {
  const fillPrice = 0.5;
  const tickSize = 0.01;
  const armActivate = fillPrice * (1 + cfg.trailActivate); // 0.575

  it("step 1: peak below activation → no trail signal, just HOLD", () => {
    // Mark just above fillPrice but below 0.575 → not armed yet
    const snap = makeSnap({ bid: 0.55, ask: 0.56, mark: 0.55, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.55,
      shares: 10,
      onChainShares: 10,
      trailArmed: false,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
  });

  it("step 2: mark crosses arm threshold → still HOLD (peak hasn't pulled back)", () => {
    // peak = mark = 0.58 (above 0.575 threshold), no pullback → HOLD
    const snap = makeSnap({ bid: 0.58, ask: 0.59, mark: 0.58, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.58,
      shares: 10,
      onChainShares: 10,
      trailArmed: false, // gets auto-armed by peak >= threshold
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
  });

  it("step 3: peak persists; mark dips just inside trailFloor → still HOLD", () => {
    // peak 0.6, trailFloor = 0.6 * (1 - 0.05) = 0.57; mark 0.575 > floor
    const snap = makeSnap({ bid: 0.575, ask: 0.585, mark: 0.575, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.6,
      shares: 10,
      onChainShares: 10,
      trailArmed: true,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
  });

  it("step 4: mark drops below trailFloor → TRAIL fires sell_bid_probe", () => {
    // peak 0.6, trailFloor = 0.57; mark 0.55 < 0.57 → fire
    const snap = makeSnap({ bid: 0.55, ask: 0.56, mark: 0.55, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.6,
      shares: 10,
      onChainShares: 10,
      trailArmed: true,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("sell_bid_probe");
    expect(i.gates).toContain("TRAIL");
    // bid+1tick = 0.56 → tick-aligned
    expect(i.price).toBeCloseTo(0.56, 5);
    expect(i.size).toBe(10);
  });

  it("step 5: trail fires from a higher peak after partial pullback (below TP)", () => {
    // peak 0.7 (was +40% earlier), trailFloor = 0.7 * 0.95 = 0.665.
    // mark 0.59 — pulled back below TP threshold (0.6) AND below trailFloor.
    // Trail fires (TP gate misses, trail catches).
    const snap = makeSnap({ bid: 0.59, ask: 0.6, mark: 0.59, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.7,
      shares: 10,
      onChainShares: 10,
      trailArmed: true,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("sell_bid_probe");
    expect(i.gates).toContain("TRAIL");
    expect(i.price).toBeCloseTo(0.6, 5); // bid+1tick
  });

  it("trail vs TP: TP takes priority when pnl >= takeProfit", () => {
    // pnl ~+24% (mark 0.62, fill 0.5) — both TP (+20%) and trail conditions met.
    // Decision tree: Gate 8 (TP) before Gate 9 (trail).
    const snap = makeSnap({ bid: 0.6, ask: 0.61, mark: 0.62, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.65, // armed (>0.575)
      shares: 10,
      onChainShares: 10,
      trailArmed: true,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.gates).toContain("TP");
    expect(i.gates).not.toContain("TRAIL");
  });

  it("trail vs SL emergency: SL emergency takes priority when -17% breached", () => {
    // mark 0.4 (-20%), peak 0.65 (was at +30% but now collapsed)
    const snap = makeSnap({ bid: 0.39, ask: 0.4, mark: 0.4, tickSize });
    const pos = makePos({
      fillPrice,
      peakPrice: 0.65,
      shares: 10,
      onChainShares: 10,
      trailArmed: true,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.gates).toContain("SL-E");
    expect(i.gates).not.toContain("TRAIL");
  });
});

describe("SL emergency sell_fok — escalation (P1.E synthetic LIVE replacement)", () => {
  const fillPrice = 0.6;
  const tickSize = 0.01;

  // -20% pnl → emergency band (SL_emergency = -17%)
  const emergencySnap = makeSnap({
    bid: 0.48,
    ask: 0.49,
    mark: 0.48,
    tickSize,
    expectedOutcomeValue: 0.5,
  });

  it("sweep 0: emergency triggers sell_bid_probe at bid+1tick", () => {
    const pos = makePos({
      fillPrice,
      shares: 10,
      onChainShares: 10,
      sweepCount: 0,
    });
    const i = decideExit(pos, emergencySnap, cfg);
    expect(i.action).toBe("sell_bid_probe");
    expect(i.gates).toContain("SL-E");
    expect(i.urgency).toBe(5);
    expect(i.price).toBeCloseTo(0.49, 5);
  });

  it("sweep 1: still sell_bid_probe (escalation only at sweep>=2)", () => {
    const pos = makePos({
      fillPrice,
      shares: 10,
      onChainShares: 10,
      sweepCount: 1,
    });
    const i = decideExit(pos, emergencySnap, cfg);
    expect(i.action).toBe("sell_bid_probe");
    expect(i.gates).toContain("SL-E");
  });

  it("sweep 2: ESCALATES to sell_fok at outcome floor", () => {
    const pos = makePos({
      fillPrice,
      shares: 10,
      onChainShares: 10,
      sweepCount: 2,
    });
    const i = decideExit(pos, emergencySnap, cfg);
    expect(i.action).toBe("sell_fok");
    expect(i.gates).toContain("SL-E");
    expect(i.urgency).toBe(5);
    // outcome floor = max(tickSize, expected*0.3) = max(0.01, 0.15) = 0.15
    expect(i.price).toBeCloseTo(0.15, 5);
    expect(i.size).toBe(10);
  });

  it("sweep 5: still sell_fok (no upper escalation cap)", () => {
    const pos = makePos({
      fillPrice,
      shares: 10,
      onChainShares: 10,
      sweepCount: 5,
    });
    const i = decideExit(pos, emergencySnap, cfg);
    expect(i.action).toBe("sell_fok");
    expect(i.urgency).toBe(5);
  });

  it("FOK price uses outcome floor exactly (not bid-derived)", () => {
    // When standard probe price (bid+1tick) is well above floor, FOK still
    // goes at floor — willing to dump at lowest acceptable to guarantee fill.
    const snap = makeSnap({
      bid: 0.4,
      ask: 0.41,
      mark: 0.45,
      tickSize,
      expectedOutcomeValue: 1.0,
    });
    const pos = makePos({
      fillPrice: 0.6,
      shares: 10,
      onChainShares: 10,
      sweepCount: 2,
    });
    // pnl = -25%, well below SL_emergency
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("sell_fok");
    // floor = max(0.01, 1.0 * 0.3) = 0.3
    expect(i.price).toBeCloseTo(0.3, 5);
  });

  it("FOK blocked by INV-M2 if outcome floor would force sub-tick price", () => {
    // expected=0 → floor = max(tickSize, 0) = tickSize. SELL @ tickSize is OK
    // (matches the floor exactly). But if expected→0 AND tick is granular,
    // we should never go below floor.
    const snap = makeSnap({
      bid: 0.001,
      ask: 0.002,
      mark: 0.001,
      tickSize: 0.01,
      expectedOutcomeValue: 0.001,
    });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      sweepCount: 2,
    });
    const i = decideExit(pos, snap, cfg);
    // If FOK would price below floor, we HOLD (not dump)
    if (i.action !== "hold") {
      expect(i.price).toBeGreaterThanOrEqual(snap.tickSize);
    }
  });
});
