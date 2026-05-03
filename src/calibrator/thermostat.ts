/**
 * thermostat — pure entry-side KPI aggregator (Layer 1 in v1 audit).
 *
 * Ported from `~/Documents/GitHub/ora-et-labora/calibrator/thermostat.py`.
 * After v1's 2026-04-22 multi_kpi rework, direction/reason live in
 * multi_kpi.ts; this module just owns the time-decayed arithmetic.
 *
 * PURE module: no DB, no I/O, no globals. Caller passes closed trades + signal
 * counts in; KpiSnapshot comes back. nowMs is injectable for tests.
 */
import type { KpiSnapshot } from "./multi_kpi.js";

const DEFAULT_HALF_LIFE_SEC = 7 * 86400;
const DEFAULT_MIN_WEIGHT = 0.05;

export interface ClosedTradeForKpi {
  /** Realized PnL in USD per trade. */
  pnlAmount: number;
  /** Trade timestamp in epoch SECONDS (caller normalizes). */
  ts: number;
}

export interface ThermostatInput {
  closedTrades: readonly ClosedTradeForKpi[];
  /** Total signals seen by the pipeline in window — drives pass_rate. */
  totalSignals: number;
  /** How many of those got accepted (mirrors v1 reject_counts.json contract). */
  acceptedSignals: number;
  /** Half-life in seconds. Default 7d. */
  halfLifeSec?: number;
  /** Minimum decay weight floor. Default 0.05. */
  minWeight?: number;
  /** Injectable wall clock in ms for deterministic tests. */
  nowMs?: number;
}

function timeDecayWeight(
  tradeTsSec: number,
  nowSec: number,
  halfLifeSec: number,
  minWeight: number,
): number {
  const age = Math.max(0, nowSec - tradeTsSec);
  const w = Math.exp((-Math.log(2) * age) / halfLifeSec);
  return Math.max(w, minWeight);
}

/**
 * Compute time-decayed entry KPIs over the supplied closed trades + signal
 * counts. Mirrors v1 thermostat.compute() shape minus the I/O side-effects.
 */
export function computeKpiSnapshot(input: ThermostatInput): KpiSnapshot {
  const halfLife = input.halfLifeSec ?? DEFAULT_HALF_LIFE_SEC;
  const minWeight = input.minWeight ?? DEFAULT_MIN_WEIGHT;
  const nowSec = (input.nowMs ?? Date.now()) / 1000;

  const passRate =
    input.totalSignals > 0 ? input.acceptedSignals / input.totalSignals : 0;

  if (input.closedTrades.length === 0) {
    return {
      win_rate: 0,
      pass_rate: round4(passRate),
      profit_factor: 0,
      avg_pnl: 0,
    };
  }

  let totalW = 0;
  let winW = 0;
  let pnlSumW = 0;
  let grossProfitW = 0;
  let grossLossW = 0;
  for (const t of input.closedTrades) {
    const w = timeDecayWeight(t.ts, nowSec, halfLife, minWeight);
    totalW += w;
    pnlSumW += t.pnlAmount * w;
    if (t.pnlAmount > 0) {
      winW += w;
      grossProfitW += t.pnlAmount * w;
    } else {
      grossLossW += Math.abs(t.pnlAmount) * w;
    }
  }
  const winRate = totalW > 0 ? winW / totalW : 0;
  const avgPnl = totalW > 0 ? pnlSumW / totalW : 0;
  // Match v1: PF defaults to 99 when grossLoss is 0.
  const pf = grossLossW > 0 ? grossProfitW / grossLossW : 99;

  return {
    win_rate: round4(winRate),
    pass_rate: round4(passRate),
    profit_factor: round4(pf),
    avg_pnl: round4(avgPnl),
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
