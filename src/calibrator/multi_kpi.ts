/**
 * multi_kpi — Layer 3 of the v1 calibrator architecture, ported verbatim
 * from `~/Documents/GitHub/ora-et-labora/calibrator/multi_kpi.py`.
 *
 * PURE module: no DB, no I/O, no logging. Every input is an argument and
 * every output is a return value. Tests in tests/calibrator/multi_kpi.spec.ts
 * cover deficit/weight/lift math without a database.
 *
 * Architecture (from spec docs/superpowers/specs/2026-05-03-calibrator-v1-port-design.md):
 *   deficits  = normalize distance-to-target per KPI ∈ [0, 1]
 *   weights   = normalize(importance × deficit) (self-gates to 0 when healthy)
 *   lift[L]   = Δ each KPI moves if lever L is applied (per lever, per cycle)
 *   score[L]  = Σ_K (weights[K] × lift_norm[L][K]) × confidence[L]
 *
 * When all KPIs hit target → weights = 0 → no recs. This is the implicit
 * "hold" gate that replaces the old MVP direction=="hold" branch.
 */

// =============================================================================
// KPI_SPEC — single source of truth for normalization + direction.
//   Values copied verbatim from v1 multi_kpi.KPI_SPEC.
// =============================================================================

export type KpiKind = "higher_better" | "lower_better" | "band";
export type KpiBucket = "entry" | "exit";

export interface KpiSpec {
  bucket: KpiBucket;
  kind: KpiKind;
  /** higher_better / lower_better target. */
  ideal?: number;
  /** higher_better / lower_better worst plausible point. */
  worst?: number;
  /** band lower bound. */
  min?: number;
  /** band upper bound. */
  max?: number;
  /** Natural-units magnitude for lift normalization (lift / scale ∈ [-1, 1]). */
  scale: number;
}

export const KPI_SPEC: Record<string, KpiSpec> = {
  win_rate: {
    bucket: "entry",
    kind: "higher_better",
    min: 0.55,
    ideal: 0.62,
    worst: 0.4,
    scale: 0.1,
  },
  profit_factor: {
    bucket: "entry",
    kind: "higher_better",
    min: 1.5,
    ideal: 2.0,
    worst: 0.5,
    scale: 0.5,
  },
  avg_pnl: {
    bucket: "entry",
    kind: "higher_better",
    min: 0.05,
    ideal: 0.35,
    worst: -0.45,
    scale: 0.2,
  },
  pass_rate: {
    bucket: "entry",
    kind: "band",
    min: 0.03,
    max: 0.08,
    scale: 0.03,
  },
  sl_rate: {
    bucket: "exit",
    kind: "lower_better",
    ideal: 0.15,
    max: 0.3,
    worst: 0.6,
    scale: 0.1,
  },
  tp_hit_rate: {
    bucket: "exit",
    kind: "higher_better",
    min: 0.2,
    ideal: 0.35,
    worst: 0.05,
    scale: 0.1,
  },
  exit_efficiency: {
    bucket: "exit",
    kind: "higher_better",
    min: 0.6,
    ideal: 0.75,
    worst: 0.3,
    scale: 0.15,
  },
  left_on_table: {
    bucket: "exit",
    kind: "lower_better",
    ideal: 0.15,
    max: 0.3,
    worst: 0.7,
    scale: 0.15,
  },
};

// _KPI_SOURCES — tells compute_deficits which snapshot field each KPI reads.
type KpiSourceField =
  | { src: "kpi"; key: keyof KpiSnapshot }
  | { src: "exit_kpi"; key: keyof ExitKpiSnapshot };

const KPI_SOURCES: Record<string, KpiSourceField> = {
  win_rate: { src: "kpi", key: "win_rate" },
  profit_factor: { src: "kpi", key: "profit_factor" },
  avg_pnl: { src: "kpi", key: "avg_pnl" },
  pass_rate: { src: "kpi", key: "pass_rate" },
  sl_rate: { src: "exit_kpi", key: "sl_rate" },
  tp_hit_rate: { src: "exit_kpi", key: "tp_hit_rate" },
  exit_efficiency: { src: "exit_kpi", key: "exit_efficiency" },
  left_on_table: { src: "exit_kpi", key: "left_on_table" },
};

// =============================================================================
// Snapshot types — emitted by thermostat.ts / exit_thermostat.ts.
// =============================================================================

export interface KpiSnapshot {
  win_rate: number;
  profit_factor: number;
  avg_pnl: number;
  pass_rate: number;
}

export interface ExitKpiSnapshot {
  sl_rate: number;
  tp_hit_rate: number;
  exit_efficiency: number;
  left_on_table: number;
}

// =============================================================================
// Per-filter counterfactual attribution — input to compute_entry_lift.
//   Emitted by Phase B counterfactual.ts. Phase A defines the shape so
//   multi_kpi can be tested independently with hand-built fixtures.
// =============================================================================

export type Phase = "entry" | "exit";

export interface FilterAttribution {
  rejectKey: string;
  configKey: string;
  humanName: string;
  phase: Phase;
  /** null = global aggregation; per-sport rows when populated. */
  sport: string | null;
  rejectCount: number;
  /** α + β - 2 from Bayesian beliefs (Beta(1,1) prior subtracted). */
  dataPoints: number;
  winnersBlocked: number;
  losersBlocked: number;
  avgWinnerPnl: number;
  avgLoserPnl: number;
  net: number;
  saved: number;
  lost: number;
}

// =============================================================================
// LeverLift — output of compute_entry_lift / compute_exit_lift.
// =============================================================================

export type LeverDirection = "relax" | "tighten" | "widen" | "narrow";

export interface LeverLift {
  configKey: string;
  rejectKey: string;
  phase: Phase;
  humanName: string;
  /** null = global lever; per-sport overrides will set this in Phase B+. */
  sport: string | null;
  direction: LeverDirection;
  currentValue: number;
  recommendedValue: number;
  delta: number;
  confidence: number;
  /** Raw Δ in native units per KPI. */
  lift: Record<string, number>;
  /** Δ / scale, sign-flipped for lower_better, clamped [-1, 1]. */
  liftNorm: Record<string, number>;
  score: number;
  /** Top-N KPIs (by weight × abs(liftNorm)) that benefit. UI label. */
  aims: string[];
  reason: string;
}

// =============================================================================
// Entry attribution allowlist — only filters whose counterfactual is
// physically measurable AND whose threshold is operator-tunable.
// Mirrors v1 multi_kpi._ENTRY_ATTRIBUTION_ALLOWLIST.
// =============================================================================

export const ENTRY_ATTRIBUTION_ALLOWLIST: ReadonlySet<string> = new Set([
  "trust_gate",
  "sm_score",
  "market_volume",
  "price_impact",
  "slippage",
  "slippage_cap",
  "price_collapsed",
  "remaining_edge",
  "time_horizon_too_close",
  "time_horizon_too_far",
  "exit_reentry_cooldown",
  "entry_cooldown",
  "conviction_gate:probe",
  "conviction_gate:confirm",
]);

// min-type config keys: relax = decrease threshold (a higher number is tighter).
// max-type (everything else) = relax = increase threshold.
export const MIN_TYPE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "FILTER_TRUST_MIN",
  "SM_SCORE_MIN_GATE",
  "FILTER_MIN_MARKET_VOLUME",
  "FILTER_MIN_REMAINING_EDGE",
  "FILTER_MIN_WHALE_SIZE_USD",
  "FILTER_MIN_TIME_TO_RESOLUTION_H",
  "FILTER_PRICE_MIN",
  "conviction_gate_probe",
  "conviction_gate_confirm",
  "FILTER_MIN_CONVICTION",
  "DRAWDOWN_MINIMAL_AT",
  "EXIT_REENTRY_COOLDOWN_S",
]);

const EXIT_HUMAN_NAMES: Record<string, string> = {
  EXIT_TAKE_PROFIT: "Take Profit",
  EXIT_STOP_LOSS: "Stop Loss",
  EXIT_STOP_LOSS_EMERGENCY: "Emergency Stop",
  EXIT_TRAIL_ACTIVATE: "Trail Activate",
  EXIT_TRAIL_STOP: "Trail Stop",
};

const SL_REASONS: ReadonlySet<string> = new Set([
  "sl_fok",
  "sl_emergency",
  "sl_aggressive",
  "sl_standard",
]);
const TP_REASONS: ReadonlySet<string> = new Set(["tp_fok", "tp"]);

/** Hard bound on any Δ estimate — prevents runaway extrapolation. */
const LIFT_ABS_CAP = 0.15;

// =============================================================================
// Pure helpers — clamps, deficit kinds.
// =============================================================================

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function deficitHigherBetter(value: number, ideal: number, worst: number): number {
  if (value >= ideal) return 0;
  const span = ideal - worst;
  if (span <= 0) return 0;
  return clamp01((ideal - value) / span);
}

function deficitLowerBetter(value: number, ideal: number, worst: number): number {
  if (value <= ideal) return 0;
  const span = worst - ideal;
  if (span <= 0) return 0;
  return clamp01((value - ideal) / span);
}

function deficitBand(value: number, lo: number, hi: number): number {
  if (value >= lo && value <= hi) return 0;
  if (value < lo) {
    if (lo <= 0) return 1;
    return clamp01((lo - value) / lo);
  }
  // value > hi
  if (hi <= 0) return 1;
  return clamp01((value - hi) / hi);
}

// =============================================================================
// compute_deficits / compute_weights — Layer 3 head.
// =============================================================================

export function computeDeficits(
  kpi: KpiSnapshot,
  exitKpi: ExitKpiSnapshot,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(KPI_SPEC)) {
    const src = KPI_SOURCES[name];
    if (!src) {
      out[name] = 0;
      continue;
    }
    const valueRaw =
      src.src === "kpi" ? kpi[src.key as keyof KpiSnapshot] : exitKpi[src.key as keyof ExitKpiSnapshot];
    const value = Number.isFinite(valueRaw) ? Number(valueRaw) : 0;
    if (spec.kind === "higher_better") {
      out[name] = deficitHigherBetter(value, spec.ideal ?? 0, spec.worst ?? 0);
    } else if (spec.kind === "lower_better") {
      out[name] = deficitLowerBetter(value, spec.ideal ?? 0, spec.worst ?? 0);
    } else {
      out[name] = deficitBand(value, spec.min ?? 0, spec.max ?? 0);
    }
  }
  return out;
}

export function computeWeights(
  deficits: Record<string, number>,
  importance: Record<string, number>,
): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const k of Object.keys(importance)) {
    const imp = Number(importance[k] ?? 0);
    const dfc = Number(deficits[k] ?? 0);
    raw[k] = (Number.isFinite(imp) ? imp : 0) * (Number.isFinite(dfc) ? dfc : 0);
  }
  let total = 0;
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (typeof v === "number") total += v;
  }
  if (total <= 0) {
    const zero: Record<string, number> = {};
    for (const k of Object.keys(importance)) zero[k] = 0;
    return zero;
  }
  const out: Record<string, number> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    out[k] = typeof v === "number" ? v / total : 0;
  }
  return out;
}

// =============================================================================
// Lift normalization + scoring.
// =============================================================================

function zeroLift(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(KPI_SPEC)) out[k] = 0;
  return out;
}

function clampLift(lift: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(lift)) {
    const v = lift[k] ?? 0;
    out[k] = Math.max(-LIFT_ABS_CAP, Math.min(LIFT_ABS_CAP, v));
  }
  return out;
}

export function normalizeLift(lift: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, vRaw] of Object.entries(lift)) {
    const spec = KPI_SPEC[k];
    const scale = spec?.scale ?? 1;
    const flipped = spec?.kind === "lower_better" ? -vRaw : vRaw;
    const norm = scale ? flipped / scale : 0;
    out[k] = Math.max(-1, Math.min(1, norm));
  }
  return out;
}

export function scoreLever(
  weights: Record<string, number>,
  liftNorm: Record<string, number>,
  confidence: number,
): number {
  let s = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (w <= 0) continue;
    s += w * (liftNorm[k] ?? 0);
  }
  return s * (Number.isFinite(confidence) ? confidence : 0);
}

export function topAims(
  liftNorm: Record<string, number>,
  weights: Record<string, number>,
  n: number,
): string[] {
  const contribs: Array<[string, number]> = [];
  for (const [k, w] of Object.entries(weights)) {
    if (w <= 0) continue;
    const c = w * Math.abs(liftNorm[k] ?? 0);
    if (c > 0.05) contribs.push([k, c]);
  }
  contribs.sort((a, b) => b[1] - a[1]);
  return contribs.slice(0, n).map(([k]) => k);
}

// =============================================================================
// compute_entry_lift — port of v1 multi_kpi.compute_entry_lift.
// =============================================================================

export interface ClosedTrade {
  pnlAmount: number;
  sport?: string | null;
}

export interface ComputeEntryLiftArgs {
  attribution: readonly FilterAttribution[];
  closedTrades: readonly ClosedTrade[];
  /** Map from configKey → current numeric value. */
  currentConfig: Record<string, number>;
  /** Map from rejectKey → confidence ∈ [0, 1]. */
  beliefs: Record<string, number>;
  /** CAL_MAX_STEP, default 0.15. */
  maxStep: number;
  totalSignals: number;
}

export function computeEntryLift(args: ComputeEntryLiftArgs): Record<string, LeverLift> {
  const {
    attribution,
    closedTrades,
    currentConfig,
    beliefs,
    maxStep,
    totalSignals,
  } = args;

  const out: Record<string, LeverLift> = {};
  const nPassed = closedTrades.length;
  if (nPassed === 0) return out;

  const winners = closedTrades.filter((t) => (t.pnlAmount ?? 0) > 0);
  const losers = closedTrades.filter((t) => (t.pnlAmount ?? 0) <= 0);
  const wrPassed = winners.length / nPassed;
  const gp = winners.reduce((s, t) => s + (t.pnlAmount ?? 0), 0);
  const gl = Math.abs(losers.reduce((s, t) => s + (t.pnlAmount ?? 0), 0));
  const pf = gl > 0 ? gp / gl : gp > 0 ? 2.0 : 1.0;
  const sumPnl = closedTrades.reduce((s, t) => s + (t.pnlAmount ?? 0), 0);
  const avgPnl = sumPnl / nPassed;

  for (const attr of attribution) {
    const rk = attr.rejectKey;
    const ck = attr.configKey;
    if (!ENTRY_ATTRIBUTION_ALLOWLIST.has(rk)) continue;
    if (!ck || !(ck in currentConfig)) continue;

    const confidence = Number(beliefs[rk] ?? 0);
    const stepFraction = maxStep * (Number.isFinite(confidence) ? confidence : 0);

    const lift = zeroLift();
    const dataPoints = Math.floor(attr.dataPoints ?? 0);
    if (dataPoints < 5) {
      const net = Number(attr.net ?? 0);
      lift["avg_pnl"] = nPassed > 0 ? (net * stepFraction) / nPassed : 0;
      const rejectCount = Math.floor(attr.rejectCount ?? 0);
      if (totalSignals > 0) {
        lift["pass_rate"] = (rejectCount * stepFraction) / totalSignals;
      }
    } else {
      const wb = Number(attr.winnersBlocked ?? 0);
      const lb = Number(attr.losersBlocked ?? 0);
      const aw = Number(attr.avgWinnerPnl ?? 0);
      const al = Number(attr.avgLoserPnl ?? 0);
      const newWinners = stepFraction * wb;
      const newLosers = stepFraction * lb;
      const denom = nPassed + newWinners + newLosers;
      if (denom > 0) {
        const newWr = (winners.length + newWinners) / denom;
        lift["win_rate"] = newWr - wrPassed;
        const newAvg = (sumPnl + newWinners * aw - newLosers * al) / denom;
        lift["avg_pnl"] = newAvg - avgPnl;
      }
      const newGp = gp + newWinners * aw;
      const newGl = gl + newLosers * al;
      if (newGl > 0) {
        lift["profit_factor"] = newGp / newGl - pf;
      }
      if (totalSignals > 0) {
        lift["pass_rate"] = (newWinners + newLosers) / totalSignals;
      }
    }

    // Direction: relax if avg_pnl lift ≥ 0; otherwise tighten (flip all signs).
    const direction: LeverDirection = (lift["avg_pnl"] ?? 0) >= 0 ? "relax" : "tighten";
    const finalLift = zeroLift();
    for (const [k, v] of Object.entries(lift)) {
      finalLift[k] = direction === "tighten" ? -v : v;
    }

    // Param delta — min-type vs max-type governs sign.
    const currentVal = Number(currentConfig[ck] ?? 0);
    const baseStep = Math.abs(currentVal) * stepFraction;
    const isMin = MIN_TYPE_CONFIG_KEYS.has(ck);
    let paramDelta: number;
    if (isMin) {
      paramDelta = direction === "relax" ? -baseStep : baseStep;
    } else {
      paramDelta = direction === "relax" ? baseStep : -baseStep;
    }
    const newVal = round4(currentVal + paramDelta);

    out[ck] = {
      configKey: ck,
      rejectKey: rk,
      phase: attr.phase,
      humanName: attr.humanName ?? rk,
      sport: attr.sport ?? null,
      direction,
      currentValue: round4(currentVal),
      recommendedValue: newVal,
      delta: round4(paramDelta),
      confidence,
      lift: finalLift,
      liftNorm: normalizeLift(finalLift),
      score: 0,
      aims: [],
      reason: "",
    };
  }
  return out;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// =============================================================================
// compute_exit_lift — port of v1 multi_kpi.compute_exit_lift.
// =============================================================================

export interface ClosedExitTrade {
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  closeReason: string;
  sport?: string | null;
}

export interface ComputeExitLiftArgs {
  closedTrades: readonly ClosedExitTrade[];
  /** Map from configKey → current value (EXIT_STOP_LOSS, EXIT_TAKE_PROFIT, etc.) */
  currentConfig: Record<string, number>;
  maxStep: number;
}

function slWidenDelta(
  trades: readonly ClosedExitTrade[],
  total: number,
  currentTp: number,
): Record<string, number> {
  // QA-127: only count SL trades whose peak ACTUALLY would have triggered TP.
  let converted = 0;
  for (const t of trades) {
    if (!SL_REASONS.has(t.closeReason)) continue;
    const ep = t.entryPrice;
    if (ep <= 0) continue;
    const peakPct = (t.peakPrice - ep) / ep;
    if (peakPct >= currentTp) converted += 1;
  }
  return {
    sl_rate: -converted / total,
    tp_hit_rate: converted / total,
    exit_efficiency: 0,
    left_on_table: 0,
  };
}

function slNarrowDelta(
  trades: readonly ClosedExitTrade[],
  total: number,
  newSl: number,
): Record<string, number> {
  let added = 0;
  for (const t of trades) {
    if (SL_REASONS.has(t.closeReason)) continue;
    const ep = t.entryPrice;
    if (ep <= 0) continue;
    const exitPct = (t.exitPrice - ep) / ep;
    const peakPct = (t.peakPrice - ep) / ep;
    if (exitPct <= newSl && peakPct < 0.05) added += 1;
  }
  return {
    sl_rate: added / total,
    tp_hit_rate: -added / total,
    exit_efficiency: 0,
    left_on_table: 0,
  };
}

function tpWidenDelta(
  trades: readonly ClosedExitTrade[],
  total: number,
  newTp: number,
): Record<string, number> {
  let lost = 0;
  for (const t of trades) {
    if (!TP_REASONS.has(t.closeReason)) continue;
    const ep = t.entryPrice;
    if (ep <= 0) continue;
    const peakPct = (t.peakPrice - ep) / ep;
    if (peakPct < newTp) lost += 1;
  }
  return {
    sl_rate: 0,
    tp_hit_rate: -lost / total,
    exit_efficiency: -0.05,
    left_on_table: 0.05,
  };
}

function tpNarrowDelta(
  trades: readonly ClosedExitTrade[],
  total: number,
  newTp: number,
): Record<string, number> {
  let gained = 0;
  for (const t of trades) {
    if (TP_REASONS.has(t.closeReason)) continue;
    const ep = t.entryPrice;
    if (ep <= 0) continue;
    const peakPct = (t.peakPrice - ep) / ep;
    if (peakPct >= newTp) gained += 1;
  }
  return {
    sl_rate: 0,
    tp_hit_rate: gained / total,
    exit_efficiency: 0.05,
    left_on_table: -0.05,
  };
}

export function computeExitLift(args: ComputeExitLiftArgs): Record<string, LeverLift> {
  const { closedTrades, currentConfig } = args;
  const closed = closedTrades.filter((t) => !!t.closeReason);
  const out: Record<string, LeverLift> = {};
  if (closed.length === 0) return out;

  const sl = currentConfig["EXIT_STOP_LOSS"];
  const tp = currentConfig["EXIT_TAKE_PROFIT"];
  if (sl === undefined || tp === undefined) return out;

  const total = closed.length;

  const emit = (
    configKey: string,
    direction: LeverDirection,
    newValue: number,
    deltaRaw: Record<string, number>,
  ): void => {
    const liftBase = zeroLift();
    for (const [k, v] of Object.entries(deltaRaw)) liftBase[k] = v;
    const lift = clampLift(liftBase);
    const current = Number(currentConfig[configKey] ?? 0);
    out[`${configKey}:${direction}`] = {
      configKey,
      rejectKey: "",
      phase: "exit",
      humanName: EXIT_HUMAN_NAMES[configKey] ?? configKey,
      sport: null,
      direction,
      currentValue: round4(current),
      recommendedValue: round4(newValue),
      delta: round4(newValue - current),
      confidence: 1.0,
      lift,
      liftNorm: normalizeLift(lift),
      score: 0,
      aims: [],
      reason: "",
    };
  };

  // EXIT_STOP_LOSS — widen / narrow.
  const emg = currentConfig["EXIT_STOP_LOSS_EMERGENCY"];
  const slWidenSafe = emg === undefined || sl > emg; // sl > emg means sl is closer to 0
  if (slWidenSafe) {
    emit("EXIT_STOP_LOSS", "widen", sl - 0.03, slWidenDelta(closed, total, tp));
  }
  emit("EXIT_STOP_LOSS", "narrow", sl + 0.03, slNarrowDelta(closed, total, sl + 0.03));

  // EXIT_TAKE_PROFIT — widen / narrow.
  emit("EXIT_TAKE_PROFIT", "widen", tp + 0.03, tpWidenDelta(closed, total, tp + 0.03));
  emit("EXIT_TAKE_PROFIT", "narrow", tp - 0.03, tpNarrowDelta(closed, total, tp - 0.03));

  // EXIT_TRAIL_ACTIVATE — narrow / widen.
  const trailAct = currentConfig["EXIT_TRAIL_ACTIVATE"];
  if (trailAct !== undefined) {
    emit("EXIT_TRAIL_ACTIVATE", "narrow", trailAct - 0.02, {
      sl_rate: -0.02,
      tp_hit_rate: 0,
      exit_efficiency: -0.02,
      left_on_table: 0.02,
    });
    emit("EXIT_TRAIL_ACTIVATE", "widen", trailAct + 0.02, {
      sl_rate: 0.02,
      tp_hit_rate: 0,
      exit_efficiency: 0.02,
      left_on_table: -0.02,
    });
  }

  // EXIT_STOP_LOSS_EMERGENCY — widen only.
  if (emg !== undefined) {
    emit("EXIT_STOP_LOSS_EMERGENCY", "widen", emg - 0.05, {
      sl_rate: -0.01,
      tp_hit_rate: 0.005,
      exit_efficiency: 0,
      left_on_table: 0,
    });
  }

  // EXIT_TRAIL_STOP — narrow / widen.
  const trailStop = currentConfig["EXIT_TRAIL_STOP"];
  if (trailStop !== undefined) {
    emit("EXIT_TRAIL_STOP", "narrow", Math.max(0.01, trailStop - 0.01), {
      sl_rate: 0,
      tp_hit_rate: 0,
      exit_efficiency: 0.01,
      left_on_table: -0.01,
    });
    emit("EXIT_TRAIL_STOP", "widen", trailStop + 0.01, {
      sl_rate: 0,
      tp_hit_rate: 0.01,
      exit_efficiency: -0.01,
      left_on_table: 0.01,
    });
  }

  return out;
}

// =============================================================================
// rank_levers — score, gate, sort, aims annotation.
// =============================================================================

export interface RankLeversArgs {
  liftMatrix: Record<string, LeverLift>;
  weights: Record<string, number>;
  minLiftThreshold: number;
  maxRecs: number;
}

export function rankLevers(args: RankLeversArgs): LeverLift[] {
  const { liftMatrix, weights, minLiftThreshold, maxRecs } = args;
  const ranked: LeverLift[] = [];
  for (const lever of Object.values(liftMatrix)) {
    const s = scoreLever(weights, lever.liftNorm, lever.confidence);
    lever.score = s;
    lever.aims = topAims(lever.liftNorm, weights, 2);
    if (s >= minLiftThreshold) ranked.push(lever);
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxRecs);
}
