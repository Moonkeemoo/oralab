/**
 * Targeted coverage tests for decide_exit branches missed by the existing
 * gate-coverage / invariant / QA suites. Each test labels the specific
 * uncovered line/branch it exercises.
 *
 * Combined with decide-paths.spec.ts and tests/decide-property.spec.ts these
 * push src/decide.ts to 95%+ branch coverage as required by SPEC §214.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../src/decide.js";
import { cfg, makePos, makeSnap, NOW } from "./helpers.js";

describe("decide_exit — extra branch coverage", () => {
  it("Terminal CLOSED → HOLD (line 77-78)", () => {
    const i = decideExit(makePos({ status: "CLOSED" }), makeSnap(), cfg);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("CLOSED");
  });

  it("Terminal FAILED → HOLD (line 77-78)", () => {
    const i = decideExit(makePos({ status: "FAILED" }), makeSnap(), cfg);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("FAILED");
  });

  it("Gate 1: status=FROZEN → FREEZE (line 82-83)", () => {
    const i = decideExit(makePos({ status: "FROZEN" }), makeSnap(), cfg);
    expect(i.action).toBe("freeze");
    expect(i.gates).toContain("INV-D3");
  });

  it("Gate 1: drift >= 0.05 → FREEZE (line 85-90)", () => {
    const i = decideExit(makePos({ reconciliationDriftPct: 0.07 }), makeSnap(), cfg);
    expect(i.action).toBe("freeze");
    expect(i.reason).toContain("drift");
  });

  it("Gate 2: snap.resolved → REDEEM (line 94-95)", () => {
    const i = decideExit(makePos(), makeSnap({ resolved: true }), cfg);
    expect(i.action).toBe("redeem");
  });

  it("Gate 2: umaResolutionStatus=resolved → REDEEM (line 94)", () => {
    const i = decideExit(makePos(), makeSnap({ umaResolutionStatus: "resolved" }), cfg);
    expect(i.action).toBe("redeem");
  });

  it("Gate 3: onChainShares = 0 → HOLD with INV-M1 (line 99-101)", () => {
    const i = decideExit(makePos({ onChainShares: 0 }), makeSnap(), cfg);
    expect(i.action).toBe("hold");
    expect(i.gates).toContain("INV-M1");
  });

  it("Gate 5: post-fill debounce on ws_book (line 116-126)", () => {
    // 1s after fill on ws_book source (debounce default 5s)
    const snap = makeSnap({ markSource: "ws_book", markTs: NOW });
    const pos = makePos({ fillTs: NOW - 1_000 });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
    expect(i.gates).toContain("QA-165");
  });

  it("Gate 5: post-fill debounce skipped when source != ws_book", () => {
    // Same timing but rest_book — should NOT debounce (debounce is ws_book-only)
    const snap = makeSnap({ markSource: "rest_book", markTs: NOW });
    const pos = makePos({ fillTs: NOW - 1_000, fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const i = decideExit(pos, snap, cfg);
    // pnl ~0, no SL/TP fires → falls through to Gate 11 HOLD
    expect(i.action).toBe("hold");
    expect(i.gates).not.toContain("QA-165");
  });

  it("Gate 6: cached_midpoint mark → HOLD QA-180 (line 129-130)", () => {
    const i = decideExit(makePos(), makeSnap({ markSource: "cached_midpoint" }), cfg);
    expect(i.action).toBe("hold");
    expect(i.gates).toContain("QA-180");
  });

  it("Gate 6: mark stale (>60s) → HOLD INV-D2 (line 132-134)", () => {
    const snap = makeSnap({ markSource: "rest_book", markTs: NOW - 120_000, fetchedAt: NOW });
    const i = decideExit(makePos(), snap, cfg);
    expect(i.action).toBe("hold");
    expect(i.gates).toContain("INV-D2");
    expect(i.reason).toContain("mark age");
  });

  it("Gate 6: dead book bid=0 → HOLD (line 136-137)", () => {
    const snap = makeSnap({ bid: 0, ask: 0.5 });
    const i = decideExit(makePos(), snap, cfg);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("dead book");
  });

  it("Gate 6: dead book ask>=1 → HOLD", () => {
    const snap = makeSnap({ bid: 0.5, ask: 1.0 });
    const i = decideExit(makePos(), snap, cfg);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("dead book");
  });

  it("Gate 6: spread > 50% → HOLD QA-180 (line 141-146)", () => {
    // bid 0.1, ask 0.9 → spread 0.8/midpoint 0.5 = 160%
    const snap = makeSnap({ bid: 0.1, ask: 0.9, mark: 0.5 });
    const i = decideExit(makePos(), snap, cfg);
    expect(i.action).toBe("hold");
    expect(i.reason).toContain("spread");
    expect(i.gates).toContain("QA-180");
  });

  it("buildSell: HOLD when chain shares = 0 inside buildSell (line 62-63)", () => {
    // Trip a SELL gate but make onChainShares=0 — but earlier Gate 3 catches it.
    // To exercise buildSell's INV-M1 branch we need pos.shares > 0 and
    // pos.onChainShares > 0 at Gate 3, then arrange for size = min(shares, onChain)
    // to be 0. Only way: shares = 0 (Gate 3 sees onChain > 0 → passes).
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 0,
      onChainShares: 10,
      fillTs: NOW - 600_000,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
    expect(i.gates).toContain("INV-M1");
  });

  it("Gate 9: trail does NOT fire when not yet armed (peak below threshold)", () => {
    const snap = makeSnap({ bid: 0.5, ask: 0.51, mark: 0.5 });
    // peak = 0.55 < fill * 1.15 = 0.575 → not armed
    const pos = makePos({
      fillPrice: 0.5,
      peakPrice: 0.55,
      trailArmed: false,
      shares: 10,
      onChainShares: 10,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
  });

  it("Gate 9: trail armed but mark above floor → HOLD", () => {
    // peak 0.6, trailFloor = 0.6 * 0.95 = 0.57; mark 0.58 > 0.57 → no fire
    const snap = makeSnap({ bid: 0.58, ask: 0.59, mark: 0.58 });
    const pos = makePos({
      fillPrice: 0.5,
      peakPrice: 0.6,
      trailArmed: true,
      shares: 10,
      onChainShares: 10,
    });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
  });

  it("fillPrice = 0 → pnlPct returns 0 (no SL/TP fires)", () => {
    const snap = makeSnap({ bid: 0.5, ask: 0.51, mark: 0.5 });
    const pos = makePos({ fillPrice: 0, shares: 10, onChainShares: 10 });
    const i = decideExit(pos, snap, cfg);
    expect(i.action).toBe("hold");
  });
});
