import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { calibratorRecommendations, positions, strategyFilters } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * Calibrator P2c.1 — adaptive filter-threshold tuning daemon.
 *
 * v1 audit (deep dive 2026-05-03 against ~/Documents/GitHub/ora-et-labora/calibrator):
 * ─────────────────────────────────────────────────────────────────────────────
 *  v1 file              │ key concept                          │ v2 status
 *  ─────────────────────┼──────────────────────────────────────┼───────────
 *  engine.py            │ orchestration + Recommendation       │ PORTED (this file)
 *                       │   .lift dict, .aims list, .score     │ PORTED (this commit)
 *                       │ _ENTRY_ATTRIBUTION_ALLOWLIST (11)    │ PORTED — TUNABLE_FILTERS now mirrors v1
 *                       │ _enforce_entry_safety (probe>confirm)│ deferred (no conviction tiers in v2 yet)
 *  multi_kpi.py         │ KPI_SPEC w/ ideal/worst/scale        │ PORTED (KPI_SPEC below)
 *                       │ compute_deficits (3 kinds)           │ PORTED (computeDeficits)
 *                       │ compute_weights (importance×deficit) │ PORTED (computeWeights)
 *                       │ compute_entry_lift                   │ PORTED simplified — uses
 *                       │                                      │   step_fraction × winners/losers
 *                       │   _normalize_lift                    │ PORTED (normalizeLift)
 *                       │   rank_levers + score                │ PORTED (rankLevers)
 *                       │ compute_exit_lift (SL/TP widen)      │ DEFERRED — no closure_reason yet
 *  bayesian.py          │ Beta(α,β) per filter                 │ NOT PORTED — sample-size tier
 *  thermostat.py        │ time-decay weighted KPIs             │ DEFERRED — flat 24h window
 *  exit_thermostat.py   │ SL/TP/trail tuning                   │ DEFERRED — separate engine
 *  counterfactual.py    │ resolve_pending() ws_state replay    │ NOT PORTED — relax-lift heuristic
 *
 * NEW in this commit (engine improvements vs MVP):
 *  1. Multi-KPI lift matrix per recommendation (avgPnl, winRate, slRate,
 *     passRate). Persisted into calibrator_recommendations.lift_matrix
 *     (jsonb). Ranking still keys on net pnl USD, but the UI now shows
 *     *which* KPIs move.
 *  2. Thermostat-lite: read last 3 recs for the same filter; flip-flopping
 *     directions force "hold" with reason "oscillating" (v1 thermostat.py
 *     had EWMA + direction stability; we approximate with a 3-window check).
 *  3. Tunable allowlist mirrors v1's _ENTRY_ATTRIBUTION_ALLOWLIST exactly.
 *     Hard-safety + structural gates (max_open_positions, total_exposure_cap,
 *     etc.) are silently ignored — they're not user-tunable thresholds.
 *  4. Counterfactual approximation rebuilt: relax lift = relax_factor *
 *     myRejects * winRate * avgWinnerPnl (replaces 0.1*avgPnl heuristic);
 *     tighten lift = tighten_factor * lossPctOfBottomDecile * acceptedCount.
 *
 * Still gap vs v1 (documented in src/calibrator/README.md): no Bayesian
 * conjugate update, no exit thermostat, no per-signal counterfactual replay.
 */

export type Direction = "relax" | "tighten" | "hold";
export type Confidence = "stable" | "exploring" | "low_data";

/** KPI names we compute lift for — subset of v1 KPI_SPEC that's measurable
 *  in v2 today (no closure_reason → no slRate from FOK; we proxy with
 *  realized_pnl_usd sign + magnitude). */
export type KpiName = "avgPnl" | "winRate" | "slRate" | "passRate";

export interface LiftMatrix {
  avgPnl: number;
  winRate: number;
  slRate: number;
  passRate: number;
}

export interface Recommendation {
  cycleId: string;
  filterName: string;
  paramKey: string;
  currentValue: number;
  recommendedValue: number;
  direction: Direction;
  liftEstimateUsd: number;
  liftKpi: string;
  confidence: Confidence;
  sampleSize: number;
  reason: string;
  liftMatrix: LiftMatrix;
  /** Top KPIs (by |normalized lift|) that benefit from this rec — UI label. */
  aims: KpiName[];
}

export interface RunCycleResult {
  cycleId: string;
  recommendations: Recommendation[];
  acceptedCount: number;
  totalPnlUsd: number;
  avgPnlPerTradeUsd: number;
}

/**
 * v1 _ENTRY_ATTRIBUTION_ALLOWLIST (engine.py:35-53) — only filters whose
 * counterfactual is physically measurable AND whose threshold is operator-
 * tunable. Excludes hard-safety (price_band, market_resolved) and structural
 * gates (max_positions, total_exposure_cap, drawdown_*) which the calibrator
 * has no business touching.
 */
export const TUNABLE_FILTERS: readonly string[] = [
  "trust_gate",
  "sm_score",
  "market_volume",
  "remaining_edge",
  "price_collapsed",
  "slippage",
  "slippage_cap",
  "price_impact",
  "entry_cooldown",
  "exit_reentry_cooldown",
  "conviction_gate",
  "time_horizon_too_close",
  "time_horizon_too_far",
] as const;

/**
 * KPI scale + direction — ported from v1 multi_kpi.KPI_SPEC. `scale` is
 * the natural-units magnitude used to normalize lift into [-1, 1] for
 * cross-KPI ranking; `kind` tells us which direction is improvement.
 *
 * Subset of v1 KPI_SPEC: omits exit-side metrics (tp_hit_rate,
 * exit_efficiency, left_on_table) because v2 doesn't yet record
 * peak_price / closure_reason on positions.
 */
export const KPI_SPEC: Record<KpiName, { kind: "higher" | "lower" | "band"; scale: number }> = {
  avgPnl: { kind: "higher", scale: 0.2 },
  winRate: { kind: "higher", scale: 0.1 },
  slRate: { kind: "lower", scale: 0.1 },
  passRate: { kind: "band", scale: 0.03 },
};

const DEFAULT_PARAM_KEY = "min";
const RELAX_FACTOR = 0.9;
const TIGHTEN_FACTOR = 1.15;
const RELAX_REJECT_THRESHOLD = 100;
const TIGHTEN_MIN_ACCEPTS = 5;
/** Threshold below which a position is considered an "SL-like" loss for
 *  proxy slRate. Mirrors v1 SL_FOK reasons, but in $ terms instead of
 *  closure_reason matching (see TODO in audit comment above). */
const SL_LOSS_THRESHOLD_USD = -1.0;
/** Window length for thermostat-lite oscillation detection. v1 thermostat.py
 *  uses time-decay EWMA over many cycles; we approximate with a fixed lookback. */
const THERMOSTAT_LOOKBACK = 3;

/**
 * Pick the tunable threshold value out of a strategy_filters params blob.
 * Convention (mirrors v1 + filters/registry.ts): primary key is "min" for
 * gate filters; cooldown filters use "thresholdProbe" or "windowSec".
 */
export function extractTunable(
  params: Record<string, unknown>,
): { paramKey: string; value: number } {
  const candidates = ["min", "thresholdProbe", "max", "windowSec", "value"];
  for (const k of candidates) {
    const v = params[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      return { paramKey: k, value: v };
    }
  }
  return { paramKey: DEFAULT_PARAM_KEY, value: 0 };
}

/** Map sample size to confidence tier — replaces v1 bayesian.py for MVP. */
export function classifyConfidence(sampleSize: number): Confidence {
  if (sampleSize > 50) return "stable";
  if (sampleSize > 10) return "exploring";
  return "low_data";
}

/**
 * Per-KPI deficit ∈ [0, 1] using v1's three-kinded normalization
 * (multi_kpi.compute_deficits). 0 = at/past target, 1 = worst plausible.
 *
 * Pure helper — exported for tests.
 */
export function computeDeficits(snapshot: {
  avgPnl: number;
  winRate: number;
  slRate: number;
  passRate: number;
}): Record<KpiName, number> {
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
  // Targets ported from v1 KPI_SPEC.
  return {
    avgPnl: clamp01((0.35 - snapshot.avgPnl) / (0.35 - -0.45)),
    winRate: clamp01((0.62 - snapshot.winRate) / (0.62 - 0.4)),
    slRate: clamp01((snapshot.slRate - 0.15) / (0.6 - 0.15)),
    passRate:
      snapshot.passRate >= 0.03 && snapshot.passRate <= 0.08
        ? 0
        : snapshot.passRate < 0.03
          ? clamp01((0.03 - snapshot.passRate) / 0.03)
          : clamp01((snapshot.passRate - 0.08) / 0.08),
  };
}

/**
 * Δ_kpi / scale, sign-flipped for lower-better KPIs so positive == improvement.
 * Output clamped to [-1, 1]. Ported from v1 multi_kpi._normalize_lift.
 */
export function normalizeLift(lift: LiftMatrix): Record<KpiName, number> {
  const out = {} as Record<KpiName, number>;
  for (const k of Object.keys(KPI_SPEC) as KpiName[]) {
    const spec = KPI_SPEC[k];
    const v = lift[k];
    const signed = spec.kind === "lower" ? -v : v;
    const norm = signed / (spec.scale || 1);
    out[k] = Math.max(-1, Math.min(1, norm));
  }
  return out;
}

/**
 * Detect direction oscillation across recent recs for the same filter.
 * Returns true if directions in the lookback window have flipped between
 * relax and tighten — caller should force "hold" with reason "oscillating".
 *
 * v1 has a thermostat module that tracks EWMA of direction stability; this
 * is a simpler discrete version: any relax→tighten or tighten→relax pair
 * inside the window trips the guard.
 */
export function detectOscillation(recentDirections: readonly Direction[]): boolean {
  const meaningful = recentDirections.filter((d) => d !== "hold");
  if (meaningful.length < 2) return false;
  const first = meaningful[0];
  return meaningful.some((d) => d !== first);
}

/**
 * Pure: compute one recommendation for one filter given the current 24h
 * KPI snapshot. The MVP single-KPI lift estimate is preserved (drives
 * ranking + UI net-USD column), and a multi-KPI lift matrix is added on top.
 *
 * recentDirections (newest first) is consulted only to gate oscillation —
 * pass [] to skip the thermostat (e.g. tests).
 */
export function computeRecommendation(
  filter: string,
  currentParams: Record<string, unknown>,
  rejectsByReason: Map<string, number>,
  avgPnlPerTrade: number,
  acceptedCount: number,
  kpiSnapshot?: { winRate: number; slRate: number; passRate: number; totalSignals: number; avgWinnerPnl: number; avgLoserPnl: number },
  recentDirections: readonly Direction[] = [],
): Omit<Recommendation, "cycleId"> | null {
  // v1 allowlist gate — any filter outside the tunable set is silently
  // dropped before lift computation (see _ENTRY_ATTRIBUTION_ALLOWLIST audit).
  if (!TUNABLE_FILTERS.includes(filter)) return null;

  const myRejects = rejectsByReason.get(filter) ?? 0;
  if (myRejects === 0 && acceptedCount === 0) return null;

  const { paramKey, value: currentValue } = extractTunable(currentParams);
  const oscillating = detectOscillation(recentDirections);

  let direction: Direction;
  let recommendedValue = currentValue;
  let liftUsd = 0;
  let reason: string;

  // v1 counterfactual approximation (replaces MVP 0.1*avgPnl heuristic):
  // relax lift = avgWinnerPnl × winRate × (relax_factor × myRejects) — i.e.
  // assume the relax fraction of currently-rejected signals would convert
  // to wins at the current observed winner rate + size. Tighten lift =
  // |avg loser pnl| × tighten_factor × acceptedCount × 0.2 (cut bottom-20%).
  const winRate = kpiSnapshot?.winRate ?? (avgPnlPerTrade > 0 ? 0.5 : 0.3);
  const avgWinnerPnl = kpiSnapshot?.avgWinnerPnl ?? Math.max(0.5, avgPnlPerTrade);
  const avgLoserPnl = kpiSnapshot?.avgLoserPnl ?? Math.abs(Math.min(-0.5, avgPnlPerTrade));

  if (avgPnlPerTrade > 0 && myRejects > RELAX_REJECT_THRESHOLD) {
    direction = "relax";
    recommendedValue = currentValue * RELAX_FACTOR;
    const stepFraction = 1 - RELAX_FACTOR; // 0.1
    // converted = stepFraction × myRejects, of which winRate are wins worth
    // avgWinnerPnl, and (1-winRate) are losses costing avgLoserPnl.
    const converted = stepFraction * myRejects;
    liftUsd = converted * (winRate * avgWinnerPnl - (1 - winRate) * avgLoserPnl);
    reason = `+$${liftUsd.toFixed(2)} if relaxed: avgPnl=$${avgPnlPerTrade.toFixed(2)}, ${myRejects} rejected/24h, wr=${(winRate * 100).toFixed(0)}%`;
  } else if (avgPnlPerTrade < 0 && acceptedCount > TIGHTEN_MIN_ACCEPTS) {
    direction = "tighten";
    recommendedValue = currentValue * TIGHTEN_FACTOR;
    // Cut the bottom 20% of accepts; assume those are losers at avgLoserPnl.
    liftUsd = 0.2 * acceptedCount * avgLoserPnl;
    reason = `+$${liftUsd.toFixed(2)} if tightened: avgPnl=$${avgPnlPerTrade.toFixed(2)}, cut bottom 20% of ${acceptedCount} accepts`;
  } else {
    direction = "hold";
    reason = `hold: avgPnl=$${avgPnlPerTrade.toFixed(2)}, sample=${acceptedCount}, rejects=${myRejects}`;
  }

  // Thermostat-lite gate (v1 thermostat.py analog): if recent recs have
  // flipped direction, force hold with explicit reason. Prevents
  // calibrator from oscillating a threshold up/down forever on noisy data.
  if ((direction === "relax" || direction === "tighten") && oscillating) {
    direction = "hold";
    recommendedValue = currentValue;
    liftUsd = 0;
    reason = `hold: oscillating direction in last ${recentDirections.length} cycles`;
  }

  // ── Multi-KPI lift matrix (port of v1 multi_kpi.compute_entry_lift) ──
  // Δ_avgPnl = (new total pnl - old total pnl) / new accepted count
  // Δ_winRate = (new winners / new accepts) - current winRate
  // Δ_slRate = relax → up if losses convert; tighten → down (cut losers)
  // Δ_passRate = (Δ accepts) / totalSignals
  const liftMatrix: LiftMatrix = { avgPnl: 0, winRate: 0, slRate: 0, passRate: 0 };
  const totalSignals = kpiSnapshot?.totalSignals ?? Math.max(1, acceptedCount + myRejects);
  if (direction === "relax") {
    const stepFraction = 1 - RELAX_FACTOR;
    const newWinners = stepFraction * myRejects * winRate;
    const newLosers = stepFraction * myRejects * (1 - winRate);
    const denom = acceptedCount + newWinners + newLosers;
    if (denom > 0 && acceptedCount > 0) {
      const oldTotalPnl = avgPnlPerTrade * acceptedCount;
      const newTotalPnl = oldTotalPnl + newWinners * avgWinnerPnl - newLosers * avgLoserPnl;
      liftMatrix.avgPnl = newTotalPnl / denom - avgPnlPerTrade;
      const newWr = (winRate * acceptedCount + newWinners) / denom;
      liftMatrix.winRate = newWr - winRate;
      // Relax adds losers proportional to (1-winRate) → slRate ticks up.
      liftMatrix.slRate = newLosers / denom;
      liftMatrix.passRate = (newWinners + newLosers) / totalSignals;
    }
  } else if (direction === "tighten") {
    const cutFraction = 0.2;
    const cut = Math.floor(cutFraction * acceptedCount);
    if (cut > 0 && acceptedCount > cut) {
      const newCount = acceptedCount - cut;
      const oldTotalPnl = avgPnlPerTrade * acceptedCount;
      const newTotalPnl = oldTotalPnl + cut * avgLoserPnl; // remove losers (subtract a negative → add positive)
      liftMatrix.avgPnl = newTotalPnl / newCount - avgPnlPerTrade;
      // Cut losers → winRate ↑ slRate ↓ passRate ↓
      const newWr = (winRate * acceptedCount) / newCount;
      liftMatrix.winRate = newWr - winRate;
      liftMatrix.slRate = -cut / newCount;
      liftMatrix.passRate = -cut / totalSignals;
    }
  }

  // aims = KPIs whose normalized lift is meaningfully positive (> 0.05),
  // sorted desc. Rendered in UI as "aims: avgPnl, winRate" pill.
  const norm = normalizeLift(liftMatrix);
  const aims = (Object.keys(norm) as KpiName[])
    .filter((k) => norm[k] > 0.05)
    .sort((a, b) => norm[b] - norm[a])
    .slice(0, 2);

  return {
    filterName: filter,
    paramKey,
    currentValue,
    recommendedValue,
    direction,
    liftEstimateUsd: liftUsd,
    liftKpi: "net_pnl",
    confidence: classifyConfidence(acceptedCount),
    sampleSize: acceptedCount,
    reason,
    liftMatrix,
    aims,
  };
}

/**
 * Sort recommendations by lift descending — UI surfaces the highest-impact
 * tweaks first. Ties broken by filter name for deterministic ordering.
 */
export function sortByScore<T extends { liftEstimateUsd: number; filterName: string }>(
  recs: readonly T[],
): T[] {
  return recs.slice().sort((a, b) => {
    if (b.liftEstimateUsd !== a.liftEstimateUsd) return b.liftEstimateUsd - a.liftEstimateUsd;
    return a.filterName.localeCompare(b.filterName);
  });
}

/**
 * Read-side helper: collect current params per filter name across all
 * configured strategy_filters rows. When a filter is configured for multiple
 * strategies we keep the first one we see (good enough for MVP).
 */
async function loadCurrentParamsByFilter(): Promise<Map<string, Record<string, unknown>>> {
  const db = getDb();
  const rows = await db.query.strategyFilters.findMany({
    where: eq(strategyFilters.enabled, true),
  });
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!out.has(r.filterName)) {
      out.set(r.filterName, (r.params as Record<string, unknown>) ?? {});
    }
  }
  return out;
}

/**
 * Read recent direction history per filter for thermostat-lite oscillation
 * detection. Returns most-recent-first slice up to THERMOSTAT_LOOKBACK.
 */
async function loadRecentDirections(): Promise<Map<string, Direction[]>> {
  const db = getDb();
  // Pull last N×|filters| rows ordered by id desc — sufficient lookback to
  // get THERMOSTAT_LOOKBACK rows per filter even with many filters.
  const lookbackRows = await db.query.calibratorRecommendations.findMany({
    orderBy: [desc(calibratorRecommendations.id)],
    limit: TUNABLE_FILTERS.length * THERMOSTAT_LOOKBACK * 2,
    columns: { filterName: true, direction: true, id: true },
  });
  const out = new Map<string, Direction[]>();
  for (const row of lookbackRows) {
    const arr = out.get(row.filterName) ?? [];
    if (arr.length < THERMOSTAT_LOOKBACK) {
      arr.push(row.direction as Direction);
      out.set(row.filterName, arr);
    }
  }
  return out;
}

/**
 * Run one calibrator cycle. Reads last-24h closed positions + rejected
 * signals, computes per-filter recs (single-KPI ranking + multi-KPI lift),
 * persists to calibrator_recommendations.
 */
export async function runCycle(): Promise<RunCycleResult> {
  const cycleId = `cyc-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const db = getDb();
  const windowMs = 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;

  // 1. Closed positions — basis for avgPnlPerTrade + winRate + avgWinnerPnl.
  const closed = await db.query.positions.findMany({
    where: and(
      eq(positions.status, "CLOSED"),
      gte(positions.lastStateChangeTs, sinceMs),
    ),
    columns: { id: true, realizedPnlUsd: true, entryCostUsd: true },
  });
  const acceptedCount = closed.length;
  const pnls = closed.map((p) => Number(p.realizedPnlUsd ?? 0));
  const totalPnlUsd = pnls.reduce((s, p) => s + p, 0);
  const avgPnlPerTrade = acceptedCount > 0 ? totalPnlUsd / acceptedCount : 0;
  const winners = pnls.filter((p) => p > 0);
  const losers = pnls.filter((p) => p <= 0);
  const winRate = acceptedCount > 0 ? winners.length / acceptedCount : 0;
  const avgWinnerPnl = winners.length > 0 ? winners.reduce((s, p) => s + p, 0) / winners.length : 0;
  const avgLoserPnl = losers.length > 0
    ? Math.abs(losers.reduce((s, p) => s + p, 0) / losers.length)
    : 0;
  // Proxy slRate: fraction of closed positions whose loss exceeded SL_LOSS_THRESHOLD_USD.
  // Honest gap vs v1: v1 reads closure_reason ∈ {sl_fok, sl_emergency, sl_aggressive}
  // (calibrator/multi_kpi._SL_REASONS); v2 hasn't wired closure_reason yet so we
  // use the dollar threshold. Documented in src/calibrator/README.md.
  const slCount = pnls.filter((p) => p < SL_LOSS_THRESHOLD_USD).length;
  const slRate = acceptedCount > 0 ? slCount / acceptedCount : 0;

  // 2. Rejected signals grouped by reject_reason — basis for myRejects + totalSignals.
  type RejectRow = { reject_reason: string | null; n: string | number };
  const rejectRows = (await db.execute(sql`
    SELECT reject_reason, count(*)::bigint AS n
    FROM signals
    WHERE processed_at > now() - interval '24 hours'
      AND accepted = false
    GROUP BY reject_reason
  `)) as unknown as RejectRow[];
  const rejectsByReason = new Map<string, number>();
  let totalRejects = 0;
  for (const r of rejectRows) {
    if (r.reject_reason) {
      const n = Number(r.n);
      rejectsByReason.set(r.reject_reason, n);
      totalRejects += n;
    }
  }
  const totalSignals = totalRejects + acceptedCount;
  const passRate = totalSignals > 0 ? acceptedCount / totalSignals : 0;

  // 3. Current params + recent directions (thermostat lookback).
  const currentParamsByFilter = await loadCurrentParamsByFilter();
  const recentDirByFilter = await loadRecentDirections();

  const kpiSnapshot = {
    winRate,
    slRate,
    passRate,
    totalSignals,
    avgWinnerPnl,
    avgLoserPnl,
  };

  // 4. Compute one rec per tunable filter.
  const recommendations: Recommendation[] = [];
  for (const f of TUNABLE_FILTERS) {
    const currentParams = currentParamsByFilter.get(f) ?? {};
    const rec = computeRecommendation(
      f,
      currentParams,
      rejectsByReason,
      avgPnlPerTrade,
      acceptedCount,
      kpiSnapshot,
      recentDirByFilter.get(f) ?? [],
    );
    if (rec) recommendations.push({ cycleId, ...rec });
  }

  // 5. Persist.
  if (recommendations.length > 0) {
    await db.insert(calibratorRecommendations).values(
      recommendations.map((r) => ({
        cycleId: r.cycleId,
        filterName: r.filterName,
        paramKey: r.paramKey,
        currentValue: r.currentValue,
        recommendedValue: r.recommendedValue,
        direction: r.direction,
        liftEstimateUsd: r.liftEstimateUsd,
        liftKpi: r.liftKpi,
        confidence: r.confidence,
        sampleSize: r.sampleSize,
        reason: r.reason,
        liftMatrix: r.liftMatrix,
        aims: r.aims,
      })),
    );
  }

  logger.info(
    {
      cycleId,
      recCount: recommendations.length,
      acceptedCount,
      totalPnlUsd,
      avgPnlPerTrade,
      winRate,
      slRate,
      passRate,
    },
    "calibrator cycle complete",
  );

  return {
    cycleId,
    recommendations: sortByScore(recommendations),
    acceptedCount,
    totalPnlUsd,
    avgPnlPerTradeUsd: avgPnlPerTrade,
  };
}
