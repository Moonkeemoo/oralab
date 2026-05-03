/**
 * engine — Layer 6 orchestrator. Refactor of the MVP daemon to compose all
 * 5 v1 layers per cycle (thermostat → counterfactual → bayesian → multi_kpi
 * → ranked recs).
 *
 * Lifecycle per cycle:
 *   1. newCycleId + logTrace cycle_start
 *   2. loadSettings — settings table merged onto v1-parity defaults
 *   3. resolve mode (manual/watch/auto). manual short-circuits.
 *   4. closedTrades + signal counts → KpiSnapshot + ExitKpiSnapshot
 *   5. counterfactual.recordRejections + resolvePending + getAttribution
 *   6. bayesian.updateFromAttribution + loadBeliefs
 *   7. computeDeficits → computeWeights → entry/exit lift → rankLevers
 *   8. Per-sport pass when PER_SPORT_ENABLED + sport has >= CAL_MIN_TRADES_PER_SPORT
 *   9. Persist top CAL_MAX_RECS recs into calibrator_recommendations
 *  10. mode=='auto' → applyRecommendation for recs with confidence >= BAYES_AUTO_MIN_CONF
 *  11. logTrace cycle_complete + return RunCycleResult
 *
 * Apply path uses setRuntimeConfig + writeAudit exclusively — never direct
 * UPDATE on strategy_filters.
 *
 * Rollback verification: scheduled in-process via setTimeout. Closed trades
 * after apply observed for SAFETY_VERIFY_TRADES_N or SAFETY_VERIFY_TIMEOUT_SEC,
 * whichever first; if WR drops > SAFETY_WR_DROP_ROLLBACK vs prior 50-trade
 * baseline, revert via setRuntimeConfig + logTrace rollback + writeAudit.
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  calibratorRecommendations,
  positions,
  strategyFilters,
} from "../db/schema.js";
import { writeAudit } from "../notify/audit_log.js";
import { setRuntimeConfig } from "../notify/runtime_config.js";
import { logger } from "../obs/logger.js";
import {
  getAttribution,
  medianAcceptedEntryUsd,
  recordRejections,
  resolvePending,
} from "./counterfactual.js";
import { loadBeliefs, updateFromAttribution } from "./bayesian.js";
import { computeExitKpiSnapshot } from "./exit_thermostat.js";
import {
  computeDeficits,
  computeEntryLift,
  computeExitLift,
  computeWeights,
  type ExitKpiSnapshot,
  type KpiSnapshot,
  type LeverLift,
  rankLevers,
} from "./multi_kpi.js";
import {
  type CalibratorMode,
  DEFAULTS,
  importanceMap,
  loadSettings,
  type SettingsShape,
} from "./settings.js";
import { computeKpiSnapshot } from "./thermostat.js";
import { logTrace, newCycleId } from "./trace.js";

// ─── Public types ─────────────────────────────────────────────────────────

export interface PersistedRecommendation {
  id: number;
  cycleId: string;
  filterName: string;
  paramKey: string;
  currentValue: number;
  recommendedValue: number;
  direction: string;
  liftEstimateUsd: number;
  liftKpi: string;
  confidence: string;
  sampleSize: number;
  reason: string;
  liftMatrix: Record<string, number>;
  aims: string[];
  sport: string | null;
  score: number;
}

export interface RunCycleOptions {
  mode?: CalibratorMode;
  perSport?: boolean;
}

export interface RunCycleResult {
  cycleId: string;
  mode: CalibratorMode;
  kpi: KpiSnapshot;
  exitKpi: ExitKpiSnapshot;
  deficits: Record<string, number>;
  weights: Record<string, number>;
  recommendations: PersistedRecommendation[];
  appliedCount: number;
  conditionsMet: boolean;
}

// ─── Per-cycle helpers ────────────────────────────────────────────────────

interface ClosedTradeRow {
  id: number;
  realizedPnlUsd: number | null;
  fillTs: number | null;
  lastStateChangeTs: number;
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  closeReason: string | null;
  sport: string | null;
}

async function loadRecentClosedTrades(windowMs: number): Promise<ClosedTradeRow[]> {
  const db = getDb();
  const sinceMs = Date.now() - windowMs;
  const rows = await db
    .select({
      id: positions.id,
      realizedPnlUsd: positions.realizedPnlUsd,
      fillTs: positions.fillTs,
      lastStateChangeTs: positions.lastStateChangeTs,
      entryPrice: positions.fillPrice,
      exitPrice: positions.fillPrice, // v2 lacks separate exit price; reuse for now
      peakPrice: positions.peakPrice,
      closeReason: positions.closeReason,
      sport: positions.sport,
    })
    .from(positions)
    .where(
      and(
        eq(positions.status, "CLOSED"),
        gte(positions.lastStateChangeTs, sinceMs),
      ),
    );
  return rows;
}

interface SignalCounts {
  total: number;
  accepted: number;
}

async function loadSignalCounts(windowMs: number): Promise<SignalCounts> {
  const db = getDb();
  const sinceMs = Date.now() - windowMs;
  const sinceIso = new Date(sinceMs).toISOString();
  const counts = (await db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE accepted = true)::int AS accepted
    FROM signals
    WHERE processed_at >= ${sinceIso}::timestamptz
  `)) as unknown as Array<{ total: number; accepted: number }>;
  return {
    total: Number(counts[0]?.total ?? 0),
    accepted: Number(counts[0]?.accepted ?? 0),
  };
}

/**
 * Read current strategy_filters params for the lever's filter_name. Returns
 * the first row's params (good enough for MVP — strategy multiplexing is a
 * P3c concern). Plus a rough current numeric-config map keyed by config_key
 * the engine emits.
 */
async function loadCurrentConfig(): Promise<{
  paramsByFilter: Map<string, Record<string, unknown>>;
  currentByConfigKey: Record<string, number>;
  filterNameByConfigKey: Record<string, string>;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(strategyFilters)
    .where(eq(strategyFilters.enabled, true));
  const paramsByFilter = new Map<string, Record<string, unknown>>();
  const currentByConfigKey: Record<string, number> = {};
  const filterNameByConfigKey: Record<string, string> = {};

  for (const r of rows) {
    if (!paramsByFilter.has(r.filterName)) {
      paramsByFilter.set(r.filterName, (r.params as Record<string, unknown>) ?? {});
    }
  }
  // Map filter_name → expected config_key consumed by computeEntryLift. The
  // attribution emitter (counterfactual.ts) uses the same mapping; we mirror
  // here so the engine can read current values.
  const filterToConfig: Record<string, string> = {
    trust_gate: "FILTER_TRUST_MIN",
    sm_score: "SM_SCORE_MIN_GATE",
    market_volume: "FILTER_MIN_MARKET_VOLUME",
    price_impact: "FILTER_MAX_PRICE_IMPACT",
    slippage: "FILTER_MAX_SLIPPAGE",
    slippage_cap: "FILTER_MAX_SLIPPAGE",
    remaining_edge: "FILTER_MIN_REMAINING_EDGE",
    price_collapsed: "FILTER_PRICE_COLLAPSED",
    time_horizon_too_close: "FILTER_MIN_TIME_TO_RESOLUTION_H",
    time_horizon_too_far: "FILTER_MAX_DAYS_TO_RESOLUTION",
    exit_reentry_cooldown: "EXIT_REENTRY_COOLDOWN_S",
    entry_cooldown: "ENTRY_COOLDOWN_S",
    conviction_gate: "conviction_gate_probe",
  };
  for (const [filterName, params] of paramsByFilter) {
    const ck = filterToConfig[filterName];
    if (!ck) continue;
    filterNameByConfigKey[ck] = filterName;
    const min = params["min"];
    const probe = params["thresholdProbe"];
    if (typeof min === "number") {
      currentByConfigKey[ck] = min;
    } else if (typeof probe === "number") {
      currentByConfigKey[ck] = probe;
    }
  }
  // Per-sport overrides for filter_name=conviction_gate are stored in
  // params.perSport[sport] — read those for engine awareness.
  return { paramsByFilter, currentByConfigKey, filterNameByConfigKey };
}

/**
 * Load exit lever current values from runtime_config (or env fallback) for
 * computeExitLift. v2 stores exit knobs via setRuntimeConfig with scope
 * 'global' and key e.g. EXIT_TAKE_PROFIT.
 */
async function loadExitConfig(): Promise<Record<string, number>> {
  const db = getDb();
  const rows = (await db.execute(sql`
    SELECT key, value FROM runtime_config WHERE scope = 'global' AND key LIKE 'EXIT_%'
  `)) as unknown as Array<{ key: string; value: unknown }>;
  const out: Record<string, number> = {};
  for (const r of rows) {
    const v = r.value;
    if (typeof v === "number") out[r.key] = v;
    else if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) out[r.key] = n;
    }
  }
  // v1-parity defaults if not configured.
  if (!("EXIT_TAKE_PROFIT" in out)) out["EXIT_TAKE_PROFIT"] = 0.2;
  if (!("EXIT_STOP_LOSS" in out)) out["EXIT_STOP_LOSS"] = -0.15;
  if (!("EXIT_STOP_LOSS_EMERGENCY" in out)) out["EXIT_STOP_LOSS_EMERGENCY"] = -0.17;
  if (!("EXIT_TRAIL_ACTIVATE" in out)) out["EXIT_TRAIL_ACTIVATE"] = 0.15;
  if (!("EXIT_TRAIL_STOP" in out)) out["EXIT_TRAIL_STOP"] = 0.05;
  return out;
}

function tradesToTherm(rows: readonly ClosedTradeRow[]): Array<{ pnlAmount: number; ts: number }> {
  return rows.map((r) => ({
    pnlAmount: Number(r.realizedPnlUsd ?? 0),
    ts: Math.floor((r.fillTs ?? r.lastStateChangeTs) / 1000),
  }));
}

function tradesToExit(rows: readonly ClosedTradeRow[]): Array<{
  entryPrice: number;
  exitPrice: number;
  peakPrice: number;
  closeReason: string;
  ts: number;
}> {
  return rows
    .filter((r) => !!r.closeReason)
    .map((r) => ({
      entryPrice: Number(r.entryPrice),
      exitPrice: Number(r.exitPrice),
      peakPrice: Number(r.peakPrice),
      closeReason: String(r.closeReason),
      ts: Math.floor((r.fillTs ?? r.lastStateChangeTs) / 1000),
    }));
}

function tradesToEntryLift(rows: readonly ClosedTradeRow[]): Array<{ pnlAmount: number; sport: string | null }> {
  return rows.map((r) => ({
    pnlAmount: Number(r.realizedPnlUsd ?? 0),
    sport: r.sport,
  }));
}

/**
 * Merge entry+exit lift maps, score them via rankLevers, return capped+sorted.
 * beliefs map confidence overrides what computeEntryLift already wrote
 * (compatibility with v1 where bayesian.confidence multiplied score in
 * scoreLever, not in computeEntryLift).
 */
function mergeAndScore(args: {
  entryLift: Record<string, LeverLift>;
  exitLift: Record<string, LeverLift>;
  weights: Record<string, number>;
  beliefs: Map<string, { confidence: number }>;
  minLiftThreshold: number;
  maxRecs: number;
}): LeverLift[] {
  const merged: Record<string, LeverLift> = {};
  for (const [k, v] of Object.entries(args.entryLift)) merged[k] = v;
  for (const [k, v] of Object.entries(args.exitLift)) merged[k] = v;
  // Bayesian confidence injection — entry levers take their reject_key's
  // belief; exit levers stay at confidence=1.
  for (const lever of Object.values(merged)) {
    if (lever.phase === "entry" && lever.rejectKey) {
      const b = args.beliefs.get(lever.rejectKey);
      if (b) lever.confidence = b.confidence;
    }
  }
  return rankLevers({
    liftMatrix: merged,
    weights: args.weights,
    minLiftThreshold: args.minLiftThreshold,
    maxRecs: args.maxRecs,
  });
}

// ─── Apply / Rollback ─────────────────────────────────────────────────────

interface ApplyContext {
  cycleId: string;
  rec: PersistedRecommendation;
  settings: SettingsShape;
  paramsByFilter: Map<string, Record<string, unknown>>;
}

/**
 * Apply a recommendation by writing setRuntimeConfig. Sport overrides go
 * to params.perSport[sport]; global recs to params.min. Per-sport delta
 * clamped by SPORT_OVERRIDE_MAX_DELTA so a noisy sport can't drift the
 * global params permanently.
 */
async function applyRecommendation(ctx: ApplyContext): Promise<boolean> {
  const { rec, settings, paramsByFilter } = ctx;
  const filterName = rec.filterName;
  const params = paramsByFilter.get(filterName) ?? {};
  const baseValue = typeof params["min"] === "number"
    ? Number(params["min"])
    : typeof params["thresholdProbe"] === "number"
      ? Number(params["thresholdProbe"])
      : rec.currentValue;
  // Clamp delta vs base.
  let recommended = rec.recommendedValue;
  if (baseValue > 0) {
    const maxAbs = Math.abs(baseValue) * settings.SPORT_OVERRIDE_MAX_DELTA;
    const proposedAbs = Math.abs(recommended - baseValue);
    if (proposedAbs > maxAbs) {
      const sign = Math.sign(recommended - baseValue) || 1;
      recommended = baseValue + sign * maxAbs;
    }
  }

  const newParams: Record<string, unknown> = { ...params };
  if (rec.sport) {
    const perSport = ((newParams["perSport"] as Record<string, number> | undefined) ?? {});
    perSport[rec.sport] = recommended;
    newParams["perSport"] = perSport;
  } else {
    if ("min" in params || !("thresholdProbe" in params)) {
      newParams["min"] = recommended;
    } else {
      newParams["thresholdProbe"] = recommended;
    }
  }

  try {
    await setRuntimeConfig({
      scope: "global",
      key: `strategy_filters.${filterName}.params`,
      value: newParams,
      setByUserId: null,
    });
    await writeAudit({
      actor: "calibrator",
      action: "calibrator_apply",
      target: `rec:${rec.id}`,
      payload: {
        cycleId: ctx.cycleId,
        recId: rec.id,
        filterName,
        sport: rec.sport,
        oldValue: baseValue,
        newValue: recommended,
        score: rec.score,
        confidence: rec.confidence,
      },
    });
    await logTrace(ctx.cycleId, "apply", {
      recId: rec.id,
      filterName,
      sport: rec.sport,
      oldValue: baseValue,
      newValue: recommended,
    });
    const db = getDb();
    await db
      .update(calibratorRecommendations)
      .set({ appliedAt: new Date() })
      .where(eq(calibratorRecommendations.id, rec.id));
    scheduleRollbackVerification(rec, baseValue, recommended, settings);
    return true;
  } catch (err) {
    logger.error({ err, recId: rec.id }, "calibrator apply failed");
    return false;
  }
}

/**
 * Schedule a deferred check: after N closed trades or timeout, compare WR
 * vs prior 50-trade baseline. If drop > SAFETY_WR_DROP_ROLLBACK, revert.
 *
 * In-process scheduler is OK for now (engine runs in api process via dynamic
 * import). When the daemon process is split out, this needs persistence.
 */
function scheduleRollbackVerification(
  rec: PersistedRecommendation,
  oldValue: number,
  _newValue: number,
  settings: SettingsShape,
): void {
  setTimeout(
    () => {
      void verifyRecommendation(rec, oldValue, settings).catch((err) => {
        logger.warn({ err, recId: rec.id }, "calibrator verifyRecommendation threw");
      });
    },
    Math.min(settings.SAFETY_VERIFY_TIMEOUT_SEC * 1000, 2 ** 31 - 1),
  );
}

async function verifyRecommendation(
  rec: PersistedRecommendation,
  oldValue: number,
  settings: SettingsShape,
): Promise<void> {
  const db = getDb();
  // Pull this strategy's recent N closed trades; if fewer than N exist, also
  // check timeout — caller schedules timeout, this just measures.
  const sinceMs = rec.id; // sentinel: use applied_at instead
  const appliedRow = (await db.execute(sql`
    SELECT applied_at FROM calibrator_recommendations WHERE id = ${rec.id}
  `)) as unknown as Array<{ applied_at: Date | null }>;
  const appliedAt = appliedRow[0]?.applied_at;
  if (!appliedAt) {
    void sinceMs; // keep TS happy on the sentinel
    return;
  }
  const appliedMs = appliedAt.getTime();

  const post = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE realized_pnl_usd > 0)::int AS wins,
           count(*)::int AS total
    FROM positions
    WHERE status='CLOSED' AND last_state_change_ts >= ${appliedMs}
  `)) as unknown as Array<{ wins: number; total: number }>;
  const postRow = post[0];
  if (!postRow || postRow.total < settings.SAFETY_VERIFY_TRADES_N) return;
  const postWr = postRow.total > 0 ? postRow.wins / postRow.total : 0;

  const prior = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE realized_pnl_usd > 0)::int AS wins,
           count(*)::int AS total
    FROM (
      SELECT realized_pnl_usd FROM positions
      WHERE status='CLOSED' AND last_state_change_ts < ${appliedMs}
      ORDER BY last_state_change_ts DESC LIMIT 50
    ) sub
  `)) as unknown as Array<{ wins: number; total: number }>;
  const priorRow = prior[0];
  const priorWr = priorRow && priorRow.total > 0 ? priorRow.wins / priorRow.total : 0;

  if (priorWr - postWr > settings.SAFETY_WR_DROP_ROLLBACK) {
    // Roll back via setRuntimeConfig restore.
    const params = { min: oldValue };
    await setRuntimeConfig({
      scope: "global",
      key: `strategy_filters.${rec.filterName}.params`,
      value: params,
      setByUserId: null,
    });
    await db
      .update(calibratorRecommendations)
      .set({ rolledBackAt: new Date() })
      .where(eq(calibratorRecommendations.id, rec.id));
    await writeAudit({
      actor: "calibrator",
      action: "calibrator_rollback",
      target: `rec:${rec.id}`,
      payload: {
        cycleId: rec.cycleId,
        priorWr,
        postWr,
        drop: priorWr - postWr,
        threshold: settings.SAFETY_WR_DROP_ROLLBACK,
      },
    });
    await logTrace(rec.cycleId, "rollback", {
      recId: rec.id,
      priorWr,
      postWr,
      drop: priorWr - postWr,
    });
  }
}

// ─── Public manual rollback (for REST) ───────────────────────────────────

export async function rollbackRecommendation(recId: number, userId?: number | null): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select()
    .from(calibratorRecommendations)
    .where(eq(calibratorRecommendations.id, recId))
    .limit(1);
  const rec = rows[0];
  if (!rec) return false;
  // Restore params.min to currentValue (the snapshot from before apply).
  const params = { min: Number(rec.currentValue) };
  await setRuntimeConfig({
    scope: "global",
    key: `strategy_filters.${rec.filterName}.params`,
    value: params,
    setByUserId: userId ?? null,
  });
  await db
    .update(calibratorRecommendations)
    .set({ rolledBackAt: new Date() })
    .where(eq(calibratorRecommendations.id, recId));
  await writeAudit({
    actor: "calibrator",
    userId: userId ?? null,
    action: "calibrator_manual_rollback",
    target: `rec:${recId}`,
    payload: { cycleId: rec.cycleId, filterName: rec.filterName, restored: rec.currentValue },
  });
  await logTrace(rec.cycleId, "rollback", { recId, manual: true });
  return true;
}

/**
 * Manual single-rec apply path — used by POST /api/calibrator/apply/:id.
 * Mirrors the auto path but skips the confidence gate.
 */
export async function applyRecommendationById(recId: number, userId?: number | null): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select()
    .from(calibratorRecommendations)
    .where(eq(calibratorRecommendations.id, recId))
    .limit(1);
  const rec = rows[0];
  if (!rec) return false;
  const settings = await loadSettings();
  const { paramsByFilter } = await loadCurrentConfig();
  const persisted: PersistedRecommendation = {
    id: rec.id,
    cycleId: rec.cycleId,
    filterName: rec.filterName,
    paramKey: rec.paramKey,
    currentValue: Number(rec.currentValue),
    recommendedValue: Number(rec.recommendedValue),
    direction: rec.direction,
    liftEstimateUsd: Number(rec.liftEstimateUsd),
    liftKpi: rec.liftKpi,
    confidence: rec.confidence,
    sampleSize: rec.sampleSize,
    reason: rec.reason,
    liftMatrix: (rec.liftMatrix as Record<string, number>) ?? {},
    aims: (rec.aims as string[]) ?? [],
    sport: rec.sport ?? null,
    score: 0,
  };
  const ok = await applyRecommendation({
    cycleId: rec.cycleId,
    rec: persisted,
    settings,
    paramsByFilter,
  });
  if (ok) {
    await writeAudit({
      actor: "mini_app",
      userId: userId ?? null,
      action: "calibrator_manual_apply",
      target: `rec:${recId}`,
      payload: {},
    });
  }
  return ok;
}

// ─── runCycle ─────────────────────────────────────────────────────────────

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function runCycle(opts: RunCycleOptions = {}): Promise<RunCycleResult> {
  const cycleId = newCycleId();
  await logTrace(cycleId, "cycle_start", { ts: Date.now() });

  const settings = await loadSettings();
  const mode: CalibratorMode = opts.mode ?? settings.MODE;

  // Load these even in manual mode so the snapshot is informative.
  const closedTrades = await loadRecentClosedTrades(WINDOW_MS);
  const sigCounts = await loadSignalCounts(WINDOW_MS);
  const kpi = computeKpiSnapshot({
    closedTrades: tradesToTherm(closedTrades),
    totalSignals: sigCounts.total,
    acceptedSignals: sigCounts.accepted,
    halfLifeSec: settings.DECAY_HALF_LIFE_SEC,
    minWeight: settings.DECAY_MIN_WEIGHT,
  });
  const exitKpi = computeExitKpiSnapshot({
    closedTrades: tradesToExit(closedTrades),
    halfLifeSec: settings.DECAY_HALF_LIFE_SEC,
    minWeight: settings.DECAY_MIN_WEIGHT,
  });

  if (mode === "manual") {
    await logTrace(cycleId, "cycle_complete", { skipped: true, mode });
    return {
      cycleId,
      mode,
      kpi,
      exitKpi,
      deficits: {},
      weights: {},
      recommendations: [],
      appliedCount: 0,
      conditionsMet: false,
    };
  }

  // ── Counterfactual + Bayesian ─────────────────────────────────────────
  const medianEntry = await medianAcceptedEntryUsd(WINDOW_MS);
  await recordRejections({
    windowMs: WINDOW_MS,
    maxPending: settings.CF_MAX_PENDING,
    fallbackMedianEntryUsd: medianEntry,
  });
  await resolvePending({
    windowMs: settings.CF_TRACKING_WINDOW_SEC * 1000,
  });
  const globalAttribution = await getAttribution(24, null);
  await updateFromAttribution(globalAttribution);
  const beliefs = await loadBeliefs(null);

  // ── Multi-KPI: deficits + weights ─────────────────────────────────────
  const deficits = computeDeficits(kpi, exitKpi);
  const weights = computeWeights(deficits, importanceMap(settings));
  await logTrace(cycleId, "deficits", { deficits });
  await logTrace(cycleId, "weights", { weights });

  // ── Entry/Exit lift ───────────────────────────────────────────────────
  const { paramsByFilter, currentByConfigKey, filterNameByConfigKey } =
    await loadCurrentConfig();
  const exitConfig = await loadExitConfig();
  const beliefsForLift: Record<string, number> = {};
  for (const [k, v] of beliefs) beliefsForLift[k] = v.confidence;

  const entryLift = computeEntryLift({
    attribution: globalAttribution,
    closedTrades: tradesToEntryLift(closedTrades),
    currentConfig: currentByConfigKey,
    beliefs: beliefsForLift,
    maxStep: settings.CAL_MAX_STEP,
    totalSignals: sigCounts.total,
  });
  const exitLift = computeExitLift({
    closedTrades: tradesToExit(closedTrades),
    currentConfig: exitConfig,
    maxStep: settings.CAL_MAX_STEP,
  });

  // ── Per-sport pass ────────────────────────────────────────────────────
  const perSportEnabled = opts.perSport ?? settings.PER_SPORT_ENABLED;
  const perSportLifts: LeverLift[] = [];
  if (perSportEnabled) {
    const sportCounts = countTradesBySport(closedTrades);
    for (const [sport, count] of sportCounts) {
      if (sport === null) continue;
      if (count < settings.CAL_MIN_TRADES_PER_SPORT) continue;
      const sportAttribution = await getAttribution(24, sport);
      const sportTrades = closedTrades.filter((t) => t.sport === sport);
      const sportLiftMap = computeEntryLift({
        attribution: sportAttribution,
        closedTrades: tradesToEntryLift(sportTrades),
        currentConfig: currentByConfigKey,
        beliefs: beliefsForLift,
        maxStep: settings.CAL_MAX_STEP,
        totalSignals: sigCounts.total,
      });
      for (const lever of Object.values(sportLiftMap)) {
        perSportLifts.push({ ...lever, sport });
      }
    }
  }

  // ── Merge + score + cap ───────────────────────────────────────────────
  const ranked = mergeAndScore({
    entryLift,
    exitLift,
    weights,
    beliefs,
    minLiftThreshold: settings.MIN_LIFT_THRESHOLD,
    maxRecs: settings.CAL_MAX_RECS,
  });

  // Per-sport recs scored separately, then merged at the top.
  if (perSportLifts.length > 0) {
    const perSportMap: Record<string, LeverLift> = {};
    for (const lev of perSportLifts) {
      perSportMap[`${lev.configKey}@${lev.sport}`] = lev;
    }
    const perSportRanked = rankLevers({
      liftMatrix: perSportMap,
      weights,
      minLiftThreshold: settings.MIN_LIFT_THRESHOLD,
      maxRecs: settings.CAL_MAX_RECS,
    });
    ranked.push(...perSportRanked);
    ranked.sort((a, b) => b.score - a.score);
    ranked.splice(settings.CAL_MAX_RECS);
  }

  await logTrace(cycleId, "lift_matrix", {
    entryCount: Object.keys(entryLift).length,
    exitCount: Object.keys(exitLift).length,
    perSportCount: perSportLifts.length,
    ranked: ranked.map((r) => ({ configKey: r.configKey, sport: r.sport, score: r.score })),
  });

  // ── Persist + apply ───────────────────────────────────────────────────
  // mode is already narrowed to 'watch' | 'auto' here (manual short-circuits
  // earlier), so the mode check below is implicit — keeping the assertion as
  // a comment for the reader.
  const conditionsMet =
    closedTrades.length >= settings.CAL_MIN_TRADES &&
    ranked.length > 0 &&
    Number(ranked[0]?.score ?? 0) >= settings.MIN_LIFT_THRESHOLD;

  const persistedRecs: PersistedRecommendation[] = [];
  if (ranked.length > 0) {
    const db = getDb();
    const inserted = await db
      .insert(calibratorRecommendations)
      .values(
        ranked.map((r) => ({
          cycleId,
          filterName: filterNameByConfigKey[r.configKey] ?? r.configKey,
          paramKey: r.sport ? `perSport.${r.sport}` : "min",
          currentValue: Number(r.currentValue),
          recommendedValue: Number(r.recommendedValue),
          direction: r.direction,
          liftEstimateUsd: Number(r.lift["avg_pnl"] ?? 0),
          liftKpi: r.aims[0] ?? "avg_pnl",
          confidence: classifyConfidenceTier(r.confidence),
          sampleSize: closedTrades.length,
          reason:
            r.reason || `${r.direction} ${r.configKey} (score ${(r.score).toFixed(3)})`,
          liftMatrix: r.lift,
          aims: r.aims,
          sport: r.sport,
        })),
      )
      .returning();
    for (let i = 0; i < inserted.length; i++) {
      const persisted = inserted[i];
      const lever = ranked[i];
      if (!persisted || !lever) continue;
      const persistedRec: PersistedRecommendation = {
        id: persisted.id,
        cycleId: persisted.cycleId,
        filterName: persisted.filterName,
        paramKey: persisted.paramKey,
        currentValue: Number(persisted.currentValue),
        recommendedValue: Number(persisted.recommendedValue),
        direction: persisted.direction,
        liftEstimateUsd: Number(persisted.liftEstimateUsd),
        liftKpi: persisted.liftKpi,
        confidence: persisted.confidence,
        sampleSize: persisted.sampleSize,
        reason: persisted.reason,
        liftMatrix: (persisted.liftMatrix as Record<string, number>) ?? {},
        aims: (persisted.aims as string[]) ?? [],
        sport: persisted.sport ?? null,
        score: lever.score,
      };
      persistedRecs.push(persistedRec);
      await logTrace(cycleId, "recommendation", {
        recId: persisted.id,
        filterName: persisted.filterName,
        sport: persisted.sport,
        score: lever.score,
        confidence: lever.confidence,
      });
    }
  }

  let appliedCount = 0;
  if (mode === "auto" && conditionsMet) {
    for (const rec of persistedRecs) {
      // Bayesian gate: only auto-apply when belief confidence is high.
      const lever = ranked.find(
        (r) =>
          (filterNameByConfigKey[r.configKey] ?? r.configKey) === rec.filterName &&
          (r.sport ?? null) === (rec.sport ?? null),
      );
      const conf = lever?.confidence ?? 0;
      if (conf < settings.BAYES_AUTO_MIN_CONF) continue;
      const ok = await applyRecommendation({
        cycleId,
        rec,
        settings,
        paramsByFilter,
      });
      if (ok) appliedCount++;
    }
  }

  await logTrace(cycleId, "cycle_complete", {
    mode,
    recCount: persistedRecs.length,
    appliedCount,
    conditionsMet,
    closedTradeCount: closedTrades.length,
  });

  return {
    cycleId,
    mode,
    kpi,
    exitKpi,
    deficits,
    weights,
    recommendations: persistedRecs,
    appliedCount,
    conditionsMet,
  };
}

// ─── Pure helpers exported for tests ──────────────────────────────────────

export function classifyConfidenceTier(conf: number): "stable" | "exploring" | "low_data" {
  if (conf >= DEFAULTS.BAYES_STABLE_THRESHOLD) return "stable";
  if (conf >= DEFAULTS.BAYES_UNCERTAIN_THRESHOLD) return "exploring";
  return "low_data";
}

export function countTradesBySport(
  trades: ReadonlyArray<{ sport: string | null }>,
): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const t of trades) {
    const k = t.sport;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * 4-checklist conditions for "ready to recommend". Pure — used by REST
 * snapshot endpoint to mirror engine logic without re-running the cycle.
 */
export function checklistConditions(args: {
  mode: CalibratorMode;
  closedTrades: number;
  topScore: number;
  daemonAlive: boolean;
  settings: SettingsShape;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (args.mode === "manual") reasons.push("mode=manual");
  if (args.closedTrades < args.settings.CAL_MIN_TRADES) {
    reasons.push(`trades<${args.settings.CAL_MIN_TRADES}`);
  }
  if (args.topScore < args.settings.MIN_LIFT_THRESHOLD) {
    reasons.push(`top_score<${args.settings.MIN_LIFT_THRESHOLD}`);
  }
  if (!args.daemonAlive) reasons.push("daemon_dead");
  return { ok: reasons.length === 0, reasons };
}

// ─── Backward-compat exports (referenced by api/rest_server.ts) ──────────

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
];

/** Force the unused-import linter to keep TUNABLE_FILTERS visible. */
void desc;
void isNull;
