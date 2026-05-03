import { describe, expect, it } from "vitest";
import { computeKpiSnapshot } from "../../src/calibrator/thermostat.js";

const NOW_MS = 1_700_000_000_000;
const SEC = 1; // ts already in seconds
const DAY = 86400;

describe("thermostat / computeKpiSnapshot", () => {
  it("returns zero snapshot when no trades", () => {
    const snap = computeKpiSnapshot({
      closedTrades: [],
      acceptedSignals: 0,
      totalSignals: 0,
      nowMs: NOW_MS,
    });
    expect(snap.win_rate).toBe(0);
    expect(snap.profit_factor).toBe(0);
    expect(snap.avg_pnl).toBe(0);
    expect(snap.pass_rate).toBe(0);
  });

  it("uses pass_rate even when no trades", () => {
    const snap = computeKpiSnapshot({
      closedTrades: [],
      acceptedSignals: 5,
      totalSignals: 100,
      nowMs: NOW_MS,
    });
    expect(snap.pass_rate).toBe(0.05);
  });

  it("all winners → wr=1, pf=99 (no losses), avg_pnl positive", () => {
    const ts = NOW_MS / 1000;
    const snap = computeKpiSnapshot({
      closedTrades: [
        { pnlAmount: 1, ts: ts * SEC },
        { pnlAmount: 2, ts: ts * SEC },
      ],
      acceptedSignals: 2,
      totalSignals: 10,
      nowMs: NOW_MS,
    });
    expect(snap.win_rate).toBe(1);
    expect(snap.profit_factor).toBe(99);
    expect(snap.avg_pnl).toBeGreaterThan(0);
  });

  it("all losers → wr=0, pf=0, avg_pnl negative", () => {
    const ts = NOW_MS / 1000;
    const snap = computeKpiSnapshot({
      closedTrades: [
        { pnlAmount: -1, ts },
        { pnlAmount: -2, ts },
      ],
      acceptedSignals: 2,
      totalSignals: 10,
      nowMs: NOW_MS,
    });
    expect(snap.win_rate).toBe(0);
    expect(snap.profit_factor).toBe(0);
    expect(snap.avg_pnl).toBeLessThan(0);
  });

  it("recent trades dominate weight (decay verification)", () => {
    const nowSec = NOW_MS / 1000;
    // Same magnitudes, but the loser is 30 days old vs winner today.
    const snap = computeKpiSnapshot({
      closedTrades: [
        { pnlAmount: 1, ts: nowSec },
        { pnlAmount: -1, ts: nowSec - 30 * DAY },
      ],
      acceptedSignals: 2,
      totalSignals: 10,
      halfLifeSec: 7 * DAY,
      minWeight: 0.05,
      nowMs: NOW_MS,
    });
    // recent winner weighs ~1; loser at 30d / 7d half-life = 2^-4.28 ≈ 0.05.
    // Snapshot tilted positive.
    expect(snap.win_rate).toBeGreaterThan(0.9);
    expect(snap.avg_pnl).toBeGreaterThan(0);
  });

  it("min_weight floor preserves ancient trade contribution", () => {
    const nowSec = NOW_MS / 1000;
    // Ancient winner that would otherwise decay to ~0; floor at 0.5.
    const snap = computeKpiSnapshot({
      closedTrades: [
        { pnlAmount: 1, ts: nowSec - 365 * DAY },
        { pnlAmount: 1, ts: nowSec },
      ],
      acceptedSignals: 2,
      totalSignals: 10,
      halfLifeSec: 7 * DAY,
      minWeight: 0.5,
      nowMs: NOW_MS,
    });
    // Both winners → wr = 1 (regardless of weight).
    expect(snap.win_rate).toBe(1);
    expect(snap.avg_pnl).toBeGreaterThan(0);
  });

  it("nowMs is injectable for determinism", () => {
    const a = computeKpiSnapshot({
      closedTrades: [{ pnlAmount: 1, ts: NOW_MS / 1000 }],
      acceptedSignals: 1,
      totalSignals: 10,
      nowMs: NOW_MS,
    });
    const b = computeKpiSnapshot({
      closedTrades: [{ pnlAmount: 1, ts: NOW_MS / 1000 }],
      acceptedSignals: 1,
      totalSignals: 10,
      nowMs: NOW_MS,
    });
    expect(a).toEqual(b);
  });

  it("mixed trades produce 0 < wr < 1, pf > 0", () => {
    const ts = NOW_MS / 1000;
    const snap = computeKpiSnapshot({
      closedTrades: [
        { pnlAmount: 2, ts },
        { pnlAmount: 1, ts },
        { pnlAmount: -0.5, ts },
        { pnlAmount: -1, ts },
      ],
      acceptedSignals: 4,
      totalSignals: 10,
      nowMs: NOW_MS,
    });
    expect(snap.win_rate).toBe(0.5);
    expect(snap.profit_factor).toBeCloseTo(3 / 1.5, 4);
    expect(snap.avg_pnl).toBeCloseTo((2 + 1 - 0.5 - 1) / 4, 4);
  });

  it("pass_rate computed from acceptedSignals/totalSignals", () => {
    const snap = computeKpiSnapshot({
      closedTrades: [{ pnlAmount: 1, ts: NOW_MS / 1000 }],
      acceptedSignals: 3,
      totalSignals: 60,
      nowMs: NOW_MS,
    });
    expect(snap.pass_rate).toBe(0.05);
  });

  it("halfLifeSec smaller → more aggressive decay (recent dominates more)", () => {
    const nowSec = NOW_MS / 1000;
    const trades = [
      { pnlAmount: 10, ts: nowSec },
      { pnlAmount: -10, ts: nowSec - 7 * DAY },
    ];
    const slow = computeKpiSnapshot({
      closedTrades: trades,
      acceptedSignals: 2,
      totalSignals: 10,
      halfLifeSec: 7 * DAY,
      nowMs: NOW_MS,
    });
    const fast = computeKpiSnapshot({
      closedTrades: trades,
      acceptedSignals: 2,
      totalSignals: 10,
      halfLifeSec: 1 * DAY,
      nowMs: NOW_MS,
    });
    // fast decay → loser contributes less → snapshot more positive.
    expect(fast.avg_pnl).toBeGreaterThan(slow.avg_pnl);
  });
});
