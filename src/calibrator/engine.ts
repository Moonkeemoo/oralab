import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { calibratorRecommendations, positions, strategyFilters } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * Calibrator MVP (P2c) — adaptive filter-threshold tuning daemon.
 *
 * Single-KPI optimisation: net pnl per accepted signal, computed over a 24h
 * rolling window of CLOSED positions. For each currently-configured tunable
 * filter we emit one recommendation row with a direction (relax/tighten/hold)
 * and a back-of-envelope lift estimate in USD. Recommendations are advisory
 * only — they are never auto-applied to strategy_filters.
 *
 * Deferred vs v1 calibrator (~3700 LOC reference at ~/Documents/GitHub/ora-et-labora):
 *  - bayesian.py confidence updates → simple sample-size tier (low_data | exploring | stable)
 *  - multi_kpi.py weighted scoring → single KPI: net_pnl
 *  - counterfactual.py would_profit → heuristic: avg pnl × relax_factor × my_rejects
 *  - thermostat / auto-apply → emit only
 *
 * See src/calibrator/README.md for run instructions and limitations.
 */

export type Direction = "relax" | "tighten" | "hold";
export type Confidence = "stable" | "exploring" | "low_data";

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
}

export interface RunCycleResult {
  cycleId: string;
  recommendations: Recommendation[];
  acceptedCount: number;
  totalPnlUsd: number;
  avgPnlPerTradeUsd: number;
}

export const TUNABLE_FILTERS: readonly string[] = [
  "trust_gate",
  "sm_score",
  "market_volume",
  "remaining_edge",
  "price_collapsed",
  "slippage_cap",
  "entry_cooldown",
  "exit_reentry_cooldown",
  "conviction_gate",
] as const;

const DEFAULT_PARAM_KEY = "min";
const RELAX_FACTOR = 0.9;
const TIGHTEN_FACTOR = 1.15;
const RELAX_REJECT_THRESHOLD = 100;
const TIGHTEN_MIN_ACCEPTS = 5;

/**
 * Pick the tunable threshold value out of a strategy_filters params blob.
 * Convention (mirrors v1 + filters/registry.ts): primary key is "min" for
 * gate filters; cooldown filters use "thresholdProbe" or "windowSec". We
 * scan in priority order and return the first numeric hit alongside its key.
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

/**
 * Map sample size to confidence tier — replaces v1 bayesian.py for MVP.
 */
export function classifyConfidence(sampleSize: number): Confidence {
  if (sampleSize > 50) return "stable";
  if (sampleSize > 10) return "exploring";
  return "low_data";
}

/**
 * Pure: compute one recommendation for one filter given the current 24h
 * KPI snapshot. Returns null when there's no signal at all (no rejects,
 * no accepts) — caller skips those rows.
 */
export function computeRecommendation(
  filter: string,
  currentParams: Record<string, unknown>,
  rejectsByReason: Map<string, number>,
  avgPnlPerTrade: number,
  acceptedCount: number,
): Omit<Recommendation, "cycleId"> | null {
  const myRejects = rejectsByReason.get(filter) ?? 0;
  if (myRejects === 0 && acceptedCount === 0) return null;

  const { paramKey, value: currentValue } = extractTunable(currentParams);

  let direction: Direction;
  let recommendedValue = currentValue;
  let liftUsd = 0;
  let reason: string;

  if (avgPnlPerTrade > 0 && myRejects > RELAX_REJECT_THRESHOLD) {
    // Profitable on accepts but rejecting a lot → we're missing winners.
    direction = "relax";
    recommendedValue = currentValue * RELAX_FACTOR;
    // Heuristic: assume 10% of currently-rejected would convert to wins at
    // the current avg pnl per trade.
    liftUsd = avgPnlPerTrade * (myRejects * 0.1);
    reason = `+$${liftUsd.toFixed(2)} if relaxed: avgPnl=$${avgPnlPerTrade.toFixed(2)}, ${myRejects} rejected/24h`;
  } else if (avgPnlPerTrade < 0 && acceptedCount > TIGHTEN_MIN_ACCEPTS) {
    // Losing money on accepts → tighten to cut the bottom 20%.
    direction = "tighten";
    recommendedValue = currentValue * TIGHTEN_FACTOR;
    liftUsd = Math.abs(avgPnlPerTrade) * (acceptedCount * 0.2);
    reason = `+$${liftUsd.toFixed(2)} if tightened: avgPnl=$${avgPnlPerTrade.toFixed(2)}, cut bottom 20% of ${acceptedCount} accepts`;
  } else {
    direction = "hold";
    reason = `hold: avgPnl=$${avgPnlPerTrade.toFixed(2)}, sample=${acceptedCount}, rejects=${myRejects}`;
  }

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
 * Run one calibrator cycle: snapshot last-24h activity, compute per-filter
 * recommendations, persist them. Caller (daemon or one-shot CLI) handles
 * scheduling and exit codes.
 */
export async function runCycle(): Promise<RunCycleResult> {
  const cycleId = `cyc-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const db = getDb();
  const windowMs = 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;

  // 1. Closed positions — basis for avgPnlPerTrade.
  const closed = await db.query.positions.findMany({
    where: and(
      eq(positions.status, "CLOSED"),
      gte(positions.lastStateChangeTs, sinceMs),
    ),
    columns: { id: true, realizedPnlUsd: true, entryCostUsd: true },
  });
  const acceptedCount = closed.length;
  const totalPnlUsd = closed.reduce((s, p) => s + Number(p.realizedPnlUsd ?? 0), 0);
  const avgPnlPerTrade = acceptedCount > 0 ? totalPnlUsd / acceptedCount : 0;

  // 2. Rejected signals grouped by reject_reason — basis for myRejects.
  type RejectRow = { reject_reason: string | null; n: string | number };
  const rejectRows = (await db.execute(sql`
    SELECT reject_reason, count(*)::bigint AS n
    FROM signals
    WHERE processed_at > now() - interval '24 hours'
      AND accepted = false
    GROUP BY reject_reason
  `)) as unknown as RejectRow[];
  const rejectsByReason = new Map<string, number>();
  for (const r of rejectRows) {
    if (r.reject_reason) rejectsByReason.set(r.reject_reason, Number(r.n));
  }

  // 3. Current params for each tunable filter from strategy_filters.
  const currentParamsByFilter = await loadCurrentParamsByFilter();

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
    );
    if (rec) recommendations.push({ cycleId, ...rec });
  }

  // 5. Persist all recs in one batch insert.
  if (recommendations.length > 0) {
    await db.insert(calibratorRecommendations).values(recommendations);
  }

  logger.info(
    {
      cycleId,
      recCount: recommendations.length,
      acceptedCount,
      totalPnlUsd,
      avgPnlPerTrade,
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
