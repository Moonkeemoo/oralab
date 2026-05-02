/**
 * Tests for shadow-replay engine. Synthetic captured decisions exercise
 * the action-matrix + drift detection without DB.
 */
import { describe, expect, it } from "vitest";
import { runReplay, type CapturedDecision } from "../../src/replay/shadow_replay.js";
import { DEFAULT_EXIT_CONFIG } from "../../src/types/decide.js";
import { makePos, makeSnap, NOW } from "../helpers.js";
import type { ExitIntent } from "../../src/types/decide.js";

function cap(
  pos: ReturnType<typeof makePos>,
  snap: ReturnType<typeof makeSnap>,
  originalIntent: ExitIntent,
  realizedPnlUsd?: number,
): CapturedDecision {
  return realizedPnlUsd !== undefined
    ? { pos, snap, originalIntent, realizedPnlUsd }
    : { pos, snap, originalIntent };
}

const cfg = DEFAULT_EXIT_CONFIG;

describe("shadow-replay runReplay", () => {
  it("identical replay (same cfg) → all unchanged", () => {
    // Build a HOLD case (mid-range pnl)
    const snap = makeSnap({ bid: 0.5, ask: 0.51, mark: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const captured = [
      cap(pos, snap, {
        action: "hold",
        price: 0,
        size: 0,
        urgency: 1,
        reason: "no signal",
        gates: [],
        snapshotTs: NOW,
      }),
    ];
    const r = runReplay(captured, { cfg });
    expect(r.total).toBe(1);
    expect(r.unchanged).toBe(1);
    expect(r.changed).toBe(0);
  });

  it("detects new SELL added when current decide_exit fires what original didn't", () => {
    // Original logged "hold" but our current code would fire SL (-20%)
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      fillTs: NOW - 600_000,
    });
    const captured = [
      cap(pos, snap, {
        action: "hold",
        price: 0,
        size: 0,
        urgency: 1,
        reason: "stale code missed",
        gates: [],
        snapshotTs: NOW,
      }),
    ];
    const r = runReplay(captured, { cfg });
    expect(r.changed).toBe(1);
    expect(r.newSellsAdded).toBe(1);
    expect(r.newSellsDropped).toBe(0);
    expect(r.actionMatrix["hold"]?.["sell_bid_probe"]).toBe(1);
  });

  it("simulated P&L impact when SELL dropped uses realizedPnlUsd", () => {
    // Cooked: snap that current code would NOT sell on (FROZEN)
    const snap = makeSnap();
    const pos = makePos({ status: "FROZEN" });
    const captured = [
      cap(
        pos,
        snap,
        {
          action: "sell_bid_probe",
          price: 0.51,
          size: 10,
          urgency: 4,
          reason: "old SL",
          gates: ["SL"],
          snapshotTs: NOW,
        },
        2.5, // we made +$2.50 historically by exiting here
      ),
    ];
    const r = runReplay(captured, { cfg });
    expect(r.newSellsDropped).toBe(1);
    // Dropping a profitable SELL costs us that P&L
    expect(r.simulatedPnlImpactUsd).toBe(-2.5);
  });

  it("price-delta avg computed only when both intents are SELL", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.42, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
      fillTs: NOW - 600_000,
    });
    // Current code on this snap fires SL at bid+1tick = 0.41
    // Pretend original was at 0.40
    const captured = [
      cap(pos, snap, {
        action: "sell_bid_probe",
        price: 0.4, // hypothetical historical price
        size: 10,
        urgency: 4,
        reason: "SL old",
        gates: ["SL"],
        snapshotTs: NOW,
      }),
    ];
    const r = runReplay(captured, { cfg });
    expect(r.averagePriceDeltaWhenBothSell).toBeCloseTo(0.01, 5);
  });

  it("action matrix accumulates correctly across multiple decisions", () => {
    const snap = makeSnap({ bid: 0.5, ask: 0.51, mark: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const captured = [
      cap(pos, snap, {
        action: "hold",
        price: 0,
        size: 0,
        urgency: 1,
        reason: "x",
        gates: [],
        snapshotTs: NOW,
      }),
      cap(pos, snap, {
        action: "hold",
        price: 0,
        size: 0,
        urgency: 1,
        reason: "x",
        gates: [],
        snapshotTs: NOW,
      }),
      cap(pos, snap, {
        action: "sell_bid_probe",
        price: 0.51,
        size: 10,
        urgency: 4,
        reason: "x",
        gates: ["SL"],
        snapshotTs: NOW,
      }),
    ];
    const r = runReplay(captured, { cfg });
    expect(r.total).toBe(3);
    expect(r.actionMatrix["hold"]?.["hold"]).toBe(2);
    expect(r.actionMatrix["sell_bid_probe"]?.["hold"]).toBe(1);
    expect(r.newSellsDropped).toBe(1);
  });

  it("detailsChangedOnly=true (default) skips unchanged in details list", () => {
    const snap = makeSnap({ bid: 0.5, ask: 0.51, mark: 0.5 });
    const pos = makePos({ fillPrice: 0.5, shares: 10, onChainShares: 10 });
    const captured = [
      cap(pos, snap, {
        action: "hold",
        price: 0,
        size: 0,
        urgency: 1,
        reason: "x",
        gates: [],
        snapshotTs: NOW,
      }),
    ];
    const r = runReplay(captured, { cfg });
    expect(r.details).toHaveLength(0);
  });

  it("maxDetails caps the details list", () => {
    const snap = makeSnap({ bid: 0.4, ask: 0.41, mark: 0.4, tickSize: 0.01 });
    const pos = makePos({
      fillPrice: 0.5,
      shares: 10,
      onChainShares: 10,
    });
    const oneCap = cap(pos, snap, {
      action: "hold",
      price: 0,
      size: 0,
      urgency: 1,
      reason: "x",
      gates: [],
      snapshotTs: NOW,
    });
    const captured = Array.from({ length: 100 }, () => oneCap);
    const r = runReplay(captured, { cfg, maxDetails: 5 });
    expect(r.details.length).toBeLessThanOrEqual(5);
    // But aggregate counts still reflect all 100
    expect(r.changed).toBe(100);
  });
});
