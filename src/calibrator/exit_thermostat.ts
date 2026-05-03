/**
 * exit_thermostat — pure exit-side KPI aggregator (Layer 1 in v1 audit).
 *
 * Ported from `~/Documents/GitHub/ora-et-labora/calibrator/exit_thermostat.py`.
 * Returns sl_rate / tp_hit_rate / exit_efficiency / left_on_table over a
 * supplied set of closed trades. Direction logic lives in multi_kpi.ts.
 *
 * PURE module: no DB, no I/O. nowMs injectable for tests.
 */
import type { ExitKpiSnapshot } from "./multi_kpi.js";

const DEFAULT_HALF_LIFE_SEC = 7 * 86400;
const DEFAULT_MIN_WEIGHT = 0.05;

const SL_REASONS: ReadonlySet<string> = new Set([
  "sl_emergency",
  "sl_aggressive",
  "sl_fok",
  "sl_standard",
]);
const TP_REASONS: ReadonlySet<string> = new Set(["tp_fok", "tp"]);

export interface ClosedTradeForExitKpi {
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  closeReason: string;
  /** Trade timestamp in epoch SECONDS. */
  ts: number;
}

export interface ExitThermostatInput {
  closedTrades: readonly ClosedTradeForExitKpi[];
  halfLifeSec?: number;
  minWeight?: number;
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

export function computeExitKpiSnapshot(input: ExitThermostatInput): ExitKpiSnapshot {
  const halfLife = input.halfLifeSec ?? DEFAULT_HALF_LIFE_SEC;
  const minWeight = input.minWeight ?? DEFAULT_MIN_WEIGHT;
  const nowSec = (input.nowMs ?? Date.now()) / 1000;

  if (input.closedTrades.length === 0) {
    return { sl_rate: 0, tp_hit_rate: 0, exit_efficiency: 0, left_on_table: 0 };
  }

  let totalW = 0;
  let tpW = 0;
  let slW = 0;
  let efficiencySumW = 0;
  let efficiencyCountW = 0;

  for (const t of input.closedTrades) {
    const w = timeDecayWeight(t.ts, nowSec, halfLife, minWeight);
    totalW += w;
    if (TP_REASONS.has(t.closeReason)) tpW += w;
    if (SL_REASONS.has(t.closeReason)) slW += w;

    // Efficiency excludes SL trades — SL measures loss containment, not exit
    // quality. Mirrors v1 exit_thermostat.compute() exactly.
    if (!SL_REASONS.has(t.closeReason)) {
      const peakGain = t.peakPrice - t.entryPrice;
      if (peakGain > 0.001) {
        const actualGain = t.exitPrice - t.entryPrice;
        const eff = Math.max(0, actualGain / peakGain);
        efficiencySumW += eff * w;
        efficiencyCountW += w;
      }
    }
  }

  const slRate = totalW > 0 ? slW / totalW : 0;
  const tpRate = totalW > 0 ? tpW / totalW : 0;
  const efficiency = efficiencyCountW > 0 ? efficiencySumW / efficiencyCountW : 0;
  const leftOnTable = 1 - efficiency;

  return {
    sl_rate: round4(slRate),
    tp_hit_rate: round4(tpRate),
    exit_efficiency: round4(efficiency),
    left_on_table: round4(leftOnTable),
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
