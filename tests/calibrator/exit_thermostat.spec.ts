import { describe, expect, it } from "vitest";
import { computeExitKpiSnapshot } from "../../src/calibrator/exit_thermostat.js";

const NOW_MS = 1_700_000_000_000;
const DAY = 86400;

describe("exit_thermostat / computeExitKpiSnapshot", () => {
  it("empty trades returns zero snapshot", () => {
    const snap = computeExitKpiSnapshot({ closedTrades: [], nowMs: NOW_MS });
    expect(snap).toEqual({
      sl_rate: 0,
      tp_hit_rate: 0,
      exit_efficiency: 0,
      left_on_table: 0,
    });
  });

  it("all TP exits → tp_hit_rate=1, sl_rate=0", () => {
    const ts = NOW_MS / 1000;
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.7, peakPrice: 0.8, closeReason: "tp_fok", ts },
        { entryPrice: 0.5, exitPrice: 0.7, peakPrice: 0.7, closeReason: "tp", ts },
      ],
      nowMs: NOW_MS,
    });
    expect(snap.tp_hit_rate).toBe(1);
    expect(snap.sl_rate).toBe(0);
  });

  it("all SL exits → sl_rate=1, tp_hit_rate=0", () => {
    const ts = NOW_MS / 1000;
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_fok", ts },
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_emergency", ts },
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_aggressive", ts },
      ],
      nowMs: NOW_MS,
    });
    expect(snap.sl_rate).toBe(1);
    expect(snap.tp_hit_rate).toBe(0);
  });

  it("efficiency excludes SL trades from numerator", () => {
    const ts = NOW_MS / 1000;
    // 1 SL trade (excluded from efficiency) + 1 TP at full peak (efficiency 1).
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_fok", ts },
        { entryPrice: 0.5, exitPrice: 0.7, peakPrice: 0.7, closeReason: "tp_fok", ts },
      ],
      nowMs: NOW_MS,
    });
    // Only the TP trade contributes to efficiency: actual=peak=0.2 → eff=1.
    expect(snap.exit_efficiency).toBe(1);
    expect(snap.left_on_table).toBe(0);
  });

  it("realized < peak → efficiency < 1 and left_on_table = 1 - efficiency", () => {
    const ts = NOW_MS / 1000;
    // peak=+50%, realized=+25% → efficiency=0.5
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.625, peakPrice: 0.75, closeReason: "tp_fok", ts },
      ],
      nowMs: NOW_MS,
    });
    expect(snap.exit_efficiency).toBeCloseTo(0.5, 4);
    expect(snap.left_on_table).toBeCloseTo(0.5, 4);
  });

  it("non-SL exits with peak ≤ entry are skipped from efficiency", () => {
    const ts = NOW_MS / 1000;
    // peak == entry → no positive peak gain → trade doesn't contribute to eff.
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.5, peakPrice: 0.5, closeReason: "time_exit", ts },
      ],
      nowMs: NOW_MS,
    });
    expect(snap.exit_efficiency).toBe(0);
    expect(snap.left_on_table).toBe(1);
  });

  it("recent trades dominate via decay weight", () => {
    const nowSec = NOW_MS / 1000;
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.7, peakPrice: 0.7, closeReason: "tp_fok", ts: nowSec },
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_fok", ts: nowSec - 30 * DAY },
      ],
      halfLifeSec: 7 * DAY,
      minWeight: 0.05,
      nowMs: NOW_MS,
    });
    // Recent TP weighs ~1; ancient SL ~0.05. tp_rate >> sl_rate.
    expect(snap.tp_hit_rate).toBeGreaterThan(snap.sl_rate);
  });

  it("min_weight floor preserves ancient trade contribution", () => {
    const nowSec = NOW_MS / 1000;
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_fok", ts: nowSec - 365 * DAY },
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_fok", ts: nowSec },
      ],
      halfLifeSec: 7 * DAY,
      minWeight: 0.5,
      nowMs: NOW_MS,
    });
    // Both SL → sl_rate=1.
    expect(snap.sl_rate).toBe(1);
  });

  it("nowMs is injectable for determinism", () => {
    const trades = [
      {
        entryPrice: 0.5,
        exitPrice: 0.6,
        peakPrice: 0.7,
        closeReason: "tp_fok",
        ts: NOW_MS / 1000,
      },
    ];
    const a = computeExitKpiSnapshot({ closedTrades: trades, nowMs: NOW_MS });
    const b = computeExitKpiSnapshot({ closedTrades: trades, nowMs: NOW_MS });
    expect(a).toEqual(b);
  });

  it("tp + sl coexist; rates partition the trade set", () => {
    const ts = NOW_MS / 1000;
    const snap = computeExitKpiSnapshot({
      closedTrades: [
        { entryPrice: 0.5, exitPrice: 0.7, peakPrice: 0.7, closeReason: "tp_fok", ts },
        { entryPrice: 0.5, exitPrice: 0.4, peakPrice: 0.55, closeReason: "sl_fok", ts },
        { entryPrice: 0.5, exitPrice: 0.5, peakPrice: 0.6, closeReason: "time_exit", ts },
        { entryPrice: 0.5, exitPrice: 0.5, peakPrice: 0.6, closeReason: "time_exit", ts },
      ],
      nowMs: NOW_MS,
    });
    expect(snap.tp_hit_rate).toBe(0.25);
    expect(snap.sl_rate).toBe(0.25);
  });
});
