/**
 * bayesian — Layer 5 of the v1 calibrator architecture.
 *
 * Ported from `~/Documents/GitHub/ora-et-labora/calibrator/bayesian.py`.
 *
 * Per-(rejectKey, sport) Beta(α, β) belief. sport=null → global belief.
 * Persisted in calibrator_beliefs table. Updated from FilterAttribution
 * via update_from_attribution: correct_ratio = saved/(saved+lost), then
 *   alpha += correct_ratio * dp
 *   beta  += (1 - correct_ratio) * dp
 *
 * confidence = α / (α + β)
 * data_points = α + β - 2 (subtract uninformative Beta(1,1) prior)
 *
 * Status tiers (from settings):
 *   stable     if conf >= BAYES_STABLE_THRESHOLD (0.7) AND dp >= 10
 *   exploring  if conf >= BAYES_UNCERTAIN_THRESHOLD (0.5)
 *   uncertain  else
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { calibratorBeliefs } from "../db/schema.js";
import type { FilterAttribution } from "./multi_kpi.js";

export type BeliefStatus = "stable" | "exploring" | "uncertain";

export interface FilterBelief {
  rejectKey: string;
  sport: string | null;
  alpha: number;
  beta: number;
  confidence: number;
  /** α + β - 2 (subtract uninformative prior). */
  dataPoints: number;
  status: BeliefStatus;
  updatedAt: number;
}

const DEFAULT_STABLE_THRESHOLD = 0.7;
const DEFAULT_UNCERTAIN_THRESHOLD = 0.5;
const DEFAULT_STABLE_DP = 10;

// ─── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Tier classification — separated from DB so it's unit-testable. v1 has
 * three discrete tiers; we mirror that exactly.
 */
export function classifyStatus(
  confidence: number,
  dataPoints: number,
  stableThr = DEFAULT_STABLE_THRESHOLD,
  uncertainThr = DEFAULT_UNCERTAIN_THRESHOLD,
): BeliefStatus {
  if (confidence >= stableThr && dataPoints >= DEFAULT_STABLE_DP) return "stable";
  if (confidence >= uncertainThr) return "exploring";
  return "uncertain";
}

/**
 * Build a FilterBelief from raw α/β + classification thresholds. Pure —
 * exported for tests + the engine uses internally when warm-loading from DB.
 */
export function deriveBelief(args: {
  rejectKey: string;
  sport: string | null;
  alpha: number;
  beta: number;
  updatedAt: number;
  stableThr?: number;
  uncertainThr?: number;
}): FilterBelief {
  const total = args.alpha + args.beta;
  const confidence = total > 0 ? args.alpha / total : 0.5;
  const dataPoints = Math.max(0, Math.floor(total - 2));
  return {
    rejectKey: args.rejectKey,
    sport: args.sport,
    alpha: args.alpha,
    beta: args.beta,
    confidence,
    dataPoints,
    status: classifyStatus(confidence, dataPoints, args.stableThr, args.uncertainThr),
    updatedAt: args.updatedAt,
  };
}

// ─── DB-touching ─────────────────────────────────────────────────────────

/**
 * Load all beliefs for a sport (or global if sport=null). Returns Map keyed
 * by rejectKey for O(1) lookup in engine scoring.
 */
export async function loadBeliefs(
  sport: string | null = null,
): Promise<Map<string, FilterBelief>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(calibratorBeliefs)
    .where(sport === null ? isNull(calibratorBeliefs.sport) : eq(calibratorBeliefs.sport, sport));

  const map = new Map<string, FilterBelief>();
  for (const r of rows) {
    map.set(
      r.rejectKey,
      deriveBelief({
        rejectKey: r.rejectKey,
        sport: r.sport,
        alpha: Number(r.alpha),
        beta: Number(r.beta),
        updatedAt: r.updatedAt.getTime(),
      }),
    );
  }
  return map;
}

/**
 * Conjugate Beta update from a list of FilterAttribution rows. Uses the v1
 * proportional update: correct_ratio drives the α/β split; dp scales the
 * pseudocount.
 *
 * Per (rejectKey, sport):
 *   if saved + lost > 0:
 *     correct_ratio = saved / (saved + lost)
 *     alpha += correct_ratio × data_points
 *     beta  += (1 - correct_ratio) × data_points
 *
 * UPSERT on (reject_key, sport) — idempotent in the sense that re-running
 * with the same attribution is allowed (it'll add up; that's intentional —
 * each cycle adds new evidence).
 */
export async function updateFromAttribution(
  attribution: readonly FilterAttribution[],
): Promise<void> {
  if (attribution.length === 0) return;
  const db = getDb();
  for (const a of attribution) {
    const saved = Number(a.saved ?? 0);
    const lost = Number(a.lost ?? 0);
    const total = saved + lost;
    if (total <= 0) continue;
    const dp = Number(a.dataPoints ?? 0);
    if (dp <= 0) continue;
    const correctRatio = saved / total;
    const alphaAdd = correctRatio * dp;
    const betaAdd = (1 - correctRatio) * dp;

    // ON CONFLICT depends on uq_cal_beliefs_key_sport. Note Drizzle's
    // partial-NULL handling for unique indexes is fine since the unique
    // constraint includes sport directly.
    await db.execute(sql`
      INSERT INTO calibrator_beliefs (reject_key, sport, alpha, beta, updated_at)
      VALUES (${a.rejectKey}, ${a.sport}, ${1 + alphaAdd}, ${1 + betaAdd}, now())
      ON CONFLICT (reject_key, sport) DO UPDATE SET
        alpha = calibrator_beliefs.alpha + ${alphaAdd},
        beta  = calibrator_beliefs.beta  + ${betaAdd},
        updated_at = now()
    `);
  }
}

/**
 * Single-key confidence read. Returns 0.5 (uninformative prior) when no row
 * exists for (rejectKey, sport).
 */
export async function getConfidence(
  rejectKey: string,
  sport: string | null = null,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .select()
    .from(calibratorBeliefs)
    .where(
      and(
        eq(calibratorBeliefs.rejectKey, rejectKey),
        sport === null ? isNull(calibratorBeliefs.sport) : eq(calibratorBeliefs.sport, sport),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return 0.5;
  const a = Number(row.alpha);
  const b = Number(row.beta);
  const tot = a + b;
  return tot > 0 ? a / tot : 0.5;
}
