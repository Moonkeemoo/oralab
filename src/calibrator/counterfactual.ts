/**
 * counterfactual — Layer 2 of the v1 calibrator architecture.
 *
 * Ported from `~/Documents/GitHub/ora-et-labora/calibrator/counterfactual.py`.
 *
 * Two phases per cycle:
 *  1. recordRejections(windowMs) — scan recent rejected signals, INSERT into
 *     cf_pending dedup'd by (condition_id, reject_key). Per-key fairness quota
 *     prevents loud filters from starving quiet ones.
 *  2. resolvePending(windowMs) — for each pending entry older than the window,
 *     look up market resolution via gamma (umaResolutionStatus === 'resolved'
 *     + outcomePrices[0]). Compute would_pnl, update cf_attribution per
 *     (reject_key, sport) AND global (sport=null).
 *
 * getAttribution(windowHours) → array of FilterAttribution rows for the
 * engine to feed compute_entry_lift.
 *
 * Conviction-gate split: rejected signals with reject_reason='conviction_gate'
 * are partitioned into `conviction_gate:probe` vs `conviction_gate:confirm`
 * based on signal.payload.intent_level.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getMarketByConditionId } from "../api/gamma.js";
import { getDb } from "../db/client.js";
import {
  cfPending,
  positions,
  signals,
} from "../db/schema.js";
import { logger } from "../obs/logger.js";
import type { FilterAttribution, Phase } from "./multi_kpi.js";

const DEFAULT_CF_MAX_PENDING = 1000;
const DEFAULT_TRACKING_WINDOW_MS = 6 * 60 * 60 * 1000;
const REJECT_KEY_QUOTA_DIVISOR = 6;
const MIN_PER_KEY_QUOTA = 30;

// Reject keys → config keys (mirrors v1 _get_reject_map fallback path). Used
// when emitting FilterAttribution rows for the engine.
const REJECT_TO_CONFIG: Record<string, string> = {
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
  "conviction_gate:probe": "conviction_gate_probe",
  "conviction_gate:confirm": "conviction_gate_confirm",
  "conviction_gate:conviction": "conviction_gate_conviction",
};

const HUMAN_NAMES: Record<string, string> = {
  trust_gate: "Trust gate",
  sm_score: "Smart money",
  market_volume: "Market volume",
  price_impact: "Price impact",
  slippage: "Slippage",
  slippage_cap: "Slippage cap",
  remaining_edge: "Remaining edge",
  price_collapsed: "Price collapsed",
  time_horizon_too_close: "Too close to resolution",
  time_horizon_too_far: "Too far from resolution",
  exit_reentry_cooldown: "Exit re-entry cooldown",
  entry_cooldown: "Entry cooldown",
  conviction_gate: "Conviction gate",
  "conviction_gate:probe": "Conviction (probe)",
  "conviction_gate:confirm": "Conviction (confirm)",
  "conviction_gate:conviction": "Conviction (strong)",
};

const REJECT_PHASES: Record<string, Phase> = {
  trust_gate: "entry",
  sm_score: "entry",
  market_volume: "entry",
  price_impact: "entry",
  slippage: "entry",
  slippage_cap: "entry",
  remaining_edge: "entry",
  price_collapsed: "entry",
  time_horizon_too_close: "entry",
  time_horizon_too_far: "entry",
  exit_reentry_cooldown: "entry",
  entry_cooldown: "entry",
  conviction_gate: "entry",
  "conviction_gate:probe": "entry",
  "conviction_gate:confirm": "entry",
  "conviction_gate:conviction": "entry",
};

// ─── Pure helpers (unit-testable without DB) ──────────────────────────────

/**
 * Free-text → canonical reject_key. v1 uses regex normalization on
 * skip_reason; our rejectReason column is already canonical, so this is
 * mostly a passthrough — but conviction_gate is intent-aware (split below).
 */
export function normalizeRejectKey(raw: string): string {
  if (!raw) return "unknown";
  // Future: pattern matching for free-text. Today rejectReason is enum-ish.
  return raw;
}

/**
 * Conviction gate splits per intent_level. probe vs confirm have different
 * thresholds; lumping them gives muddy attribution. v1 counterfactual.py:120.
 */
export function splitConvictionGate(
  rejectKey: string,
  intentLevel: string | null | undefined,
): string {
  if (rejectKey !== "conviction_gate") return rejectKey;
  const intent = (intentLevel ?? "").toLowerCase();
  if (intent === "probe" || intent === "confirm" || intent === "conviction") {
    return `conviction_gate:${intent}`;
  }
  return rejectKey;
}

/**
 * Per-key fairness quota: max(MIN_PER_KEY_QUOTA, maxPending / 6) so a loud
 * filter (whale_size_floor on prod) can't fill the whole table and starve
 * quiet ones (sm_score, time_horizon_*).
 */
export function perKeyQuota(maxPending: number): number {
  return Math.max(MIN_PER_KEY_QUOTA, Math.floor(maxPending / REJECT_KEY_QUOTA_DIVISOR));
}

/**
 * Hypothetical size $ for a rejected signal — what the engine would have
 * staked if it had accepted. Strategy.params.baseSizeUsd × convictionScore;
 * fallback to median entry_cost_usd of accepted positions.
 */
export function hypotheticalSizeUsd(args: {
  baseSizeUsd: number;
  convictionScore?: number | null;
  fallbackMedianEntryUsd?: number | null;
}): number {
  const c = args.convictionScore ?? 1.0;
  if (Number.isFinite(args.baseSizeUsd) && args.baseSizeUsd > 0) {
    return Number(args.baseSizeUsd) * Number(c);
  }
  if (args.fallbackMedianEntryUsd && args.fallbackMedianEntryUsd > 0) {
    return Number(args.fallbackMedianEntryUsd);
  }
  return 1.0;
}

// ─── DB-touching phases ───────────────────────────────────────────────────

export interface RecordRejectionsResult {
  inserted: number;
  skippedDup: number;
  skippedQuota: number;
  scanned: number;
}

export interface RecordRejectionsOptions {
  windowMs?: number;
  maxPending?: number;
  /** Median accepted entry_cost_usd to seed hypothetical_size when no convictionScore. */
  fallbackMedianEntryUsd?: number;
}

interface RejectedSignalRow {
  id: number;
  conditionId: string;
  assetId: string;
  rejectReason: string | null;
  sport: string | null;
  priceHint: number | null;
  payload: unknown;
  receivedTs: number;
}

/**
 * Scan signals (accepted=false) within the window, insert one cf_pending row
 * per (condition_id, reject_key) up to maxPending overall AND perKeyQuota
 * per reject_key. Returns counts for telemetry.
 */
export async function recordRejections(
  opts: RecordRejectionsOptions = {},
): Promise<RecordRejectionsResult> {
  const windowMs = opts.windowMs ?? DEFAULT_TRACKING_WINDOW_MS;
  const maxPending = opts.maxPending ?? DEFAULT_CF_MAX_PENDING;
  const quota = perKeyQuota(maxPending);
  const db = getDb();

  // 1. How many cf_pending rows exist now? Bail if at cap.
  const countRows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM cf_pending`,
  )) as unknown as Array<{ n: number }>;
  const existingCount = Number(countRows[0]?.n ?? 0);
  if (existingCount >= maxPending) {
    return { inserted: 0, skippedDup: 0, skippedQuota: 0, scanned: 0 };
  }

  // 2. Per-key occupancy in cf_pending.
  const perKeyRows = (await db.execute(
    sql`SELECT reject_key, count(*)::int AS n FROM cf_pending GROUP BY reject_key`,
  )) as unknown as Array<{ reject_key: string; n: number }>;
  const perKey = new Map<string, number>();
  for (const r of perKeyRows) {
    perKey.set(r.reject_key, Number(r.n));
  }

  // 3. Pull recent rejections.
  const sinceMs = Date.now() - windowMs;
  const sinceDate = new Date(sinceMs);
  const rawRejects = await db
    .select({
      id: signals.id,
      conditionId: signals.conditionId,
      assetId: signals.assetId,
      rejectReason: signals.rejectReason,
      sport: signals.sport,
      priceHint: signals.priceHint,
      payload: signals.payload,
      receivedTs: signals.receivedTs,
    })
    .from(signals)
    .where(
      and(
        eq(signals.accepted, false),
        gte(signals.processedAt, sinceDate),
      ),
    )
    .orderBy(desc(signals.processedAt))
    .limit(5000);

  let inserted = 0;
  let skippedDup = 0;
  let skippedQuota = 0;
  let budget = maxPending - existingCount;

  for (const sig of rawRejects as RejectedSignalRow[]) {
    if (budget <= 0) break;
    if (!sig.rejectReason) continue;

    const baseKey = normalizeRejectKey(sig.rejectReason);
    const payload = (sig.payload ?? {}) as Record<string, unknown>;
    const intentLevel = typeof payload["intent_level"] === "string"
      ? (payload["intent_level"] as string)
      : null;
    const rejectKey = splitConvictionGate(baseKey, intentLevel);

    const used = perKey.get(rejectKey) ?? 0;
    if (used >= quota) {
      skippedQuota++;
      continue;
    }

    const baseSizeUsd = typeof payload["baseSizeUsd"] === "number"
      ? (payload["baseSizeUsd"] as number)
      : 1.0;
    const convictionScore = typeof payload["convictionScore"] === "number"
      ? (payload["convictionScore"] as number)
      : null;
    const hypSize = hypotheticalSizeUsd({
      baseSizeUsd,
      convictionScore,
      fallbackMedianEntryUsd: opts.fallbackMedianEntryUsd ?? null,
    });

    try {
      const inserted1 = await db
        .insert(cfPending)
        .values({
          conditionId: sig.conditionId,
          rejectKey,
          assetId: sig.assetId,
          sport: sig.sport,
          whalePrice: sig.priceHint,
          hypotheticalSizeUsd: hypSize,
          recordedTs: sig.receivedTs,
        })
        .onConflictDoNothing({ target: [cfPending.conditionId, cfPending.rejectKey] })
        .returning({ id: cfPending.id });
      if (inserted1.length === 0) {
        skippedDup++;
      } else {
        inserted++;
        perKey.set(rejectKey, used + 1);
        budget--;
      }
    } catch (err) {
      logger.warn({ err, rejectKey, cid: sig.conditionId }, "cf_pending insert failed");
    }
  }

  return { inserted, skippedDup, skippedQuota, scanned: rawRejects.length };
}

export interface ResolvePendingResult {
  resolved: number;
  unresolved: number;
  expired: number;
}

export interface ResolvePendingOptions {
  windowMs?: number;
  /** Hard GC after 2× window — drop entries with no resolution. */
  hardGcMultiplier?: number;
  /** Cap on Gamma calls per cycle. */
  gammaBudget?: number;
}

interface PendingRow {
  id: number;
  conditionId: string;
  rejectKey: string;
  assetId: string;
  sport: string | null;
  whalePrice: number | null;
  hypotheticalSizeUsd: number | null;
  recordedTs: number;
}

/**
 * For each pending entry where recordedTs < now - windowMs, look up market
 * resolution via gamma. Compute would_pnl = (resolved_price - whale_price) ×
 * hypothetical_size. Update cf_attribution per (rejectKey, sport) AND global.
 *
 * Hard GC: entries older than 2×windowMs are dropped (no signal of resolution
 * is itself information — but stale phantom rows pollute attribution).
 */
export async function resolvePending(
  opts: ResolvePendingOptions = {},
): Promise<ResolvePendingResult> {
  const windowMs = opts.windowMs ?? DEFAULT_TRACKING_WINDOW_MS;
  const hardGcMultiplier = opts.hardGcMultiplier ?? 2;
  let gammaBudget = opts.gammaBudget ?? 30;
  const db = getDb();
  const now = Date.now();
  const cutoff = now - windowMs;
  const hardCutoff = now - windowMs * hardGcMultiplier;

  const ripe = (await db
    .select({
      id: cfPending.id,
      conditionId: cfPending.conditionId,
      rejectKey: cfPending.rejectKey,
      assetId: cfPending.assetId,
      sport: cfPending.sport,
      whalePrice: cfPending.whalePrice,
      hypotheticalSizeUsd: cfPending.hypotheticalSizeUsd,
      recordedTs: cfPending.recordedTs,
    })
    .from(cfPending)
    .where(lt(cfPending.recordedTs, cutoff))
    .limit(500)) as PendingRow[];

  let resolved = 0;
  let unresolved = 0;
  let expired = 0;

  for (const p of ripe) {
    // Hard GC first.
    if (p.recordedTs < hardCutoff) {
      await db.delete(cfPending).where(eq(cfPending.id, p.id));
      expired++;
      continue;
    }

    if (gammaBudget <= 0) {
      unresolved++;
      continue;
    }
    gammaBudget--;

    let resolvedPrice: number | null = null;
    try {
      const market = await getMarketByConditionId(p.conditionId);
      if (market && market.umaResolutionStatus === "resolved") {
        // Match by assetId in tokens; fallback to outcomes[0] (binary YES).
        const tok = market.tokens.find((t) => t.tokenId === p.assetId);
        const idx = tok ? market.tokens.indexOf(tok) : 0;
        const px = market.outcomePricesParsed[idx];
        if (typeof px === "number" && Number.isFinite(px)) resolvedPrice = px;
      }
    } catch (err) {
      logger.debug({ err, cid: p.conditionId }, "gamma lookup threw in resolver");
    }

    if (resolvedPrice === null) {
      unresolved++;
      continue;
    }

    const whalePrice = Number(p.whalePrice ?? 0);
    const hypSize = Number(p.hypotheticalSizeUsd ?? 1);
    // (resolved - entry) × size. Resolved is 0/1; entry is the price the
    // whale (and we, had we accepted) would have paid.
    const wouldPnl = (resolvedPrice - whalePrice) * hypSize;

    await applyAttributionUpdate(p.rejectKey, p.sport, wouldPnl, now);
    if (p.sport !== null && p.sport !== undefined) {
      // Also update the global (sport=null) row.
      await applyAttributionUpdate(p.rejectKey, null, wouldPnl, now);
    } else {
      // Already global; nothing else to do.
    }

    await db.delete(cfPending).where(eq(cfPending.id, p.id));
    resolved++;
  }

  return { resolved, unresolved, expired };
}

/**
 * Upsert one cf_attribution row keyed by (rejectKey, sport, windowStartTs).
 * windowStartTs uses bucket of 24h aligned to UTC midnight so multiple cycles
 * within a day collapse into the same row.
 */
async function applyAttributionUpdate(
  rejectKey: string,
  sport: string | null,
  wouldPnl: number,
  now: number,
): Promise<void> {
  const db = getDb();
  const dayMs = 24 * 60 * 60 * 1000;
  const windowStartTs = Math.floor(now / dayMs) * dayMs;
  const windowEndTs = windowStartTs + dayMs;
  const isWinner = wouldPnl > 0;
  const absPnl = Math.abs(wouldPnl);

  // SQL upsert with running-mean math. avgWinnerPnl = (old_avg * old_n + new_pnl) / (old_n + 1).
  await db.execute(sql`
    INSERT INTO cf_attribution (
      reject_key, sport, window_start_ts, window_end_ts,
      reject_count, data_points, winners_blocked, losers_blocked,
      avg_winner_pnl, avg_loser_pnl, saved_usd, lost_usd, net_usd
    ) VALUES (
      ${rejectKey},
      ${sport},
      ${windowStartTs},
      ${windowEndTs},
      1, 1,
      ${isWinner ? 1 : 0},
      ${isWinner ? 0 : 1},
      ${isWinner ? absPnl : 0},
      ${isWinner ? 0 : absPnl},
      ${isWinner ? 0 : absPnl},
      ${isWinner ? absPnl : 0},
      ${isWinner ? -absPnl : absPnl}
    )
    ON CONFLICT (reject_key, sport, window_start_ts) DO UPDATE SET
      reject_count = cf_attribution.reject_count + 1,
      data_points  = cf_attribution.data_points + 1,
      winners_blocked = cf_attribution.winners_blocked + ${isWinner ? 1 : 0},
      losers_blocked  = cf_attribution.losers_blocked  + ${isWinner ? 0 : 1},
      avg_winner_pnl = CASE
        WHEN ${isWinner} THEN
          (cf_attribution.avg_winner_pnl * cf_attribution.winners_blocked + ${absPnl})
            / NULLIF(cf_attribution.winners_blocked + 1, 0)
        ELSE cf_attribution.avg_winner_pnl
      END,
      avg_loser_pnl = CASE
        WHEN ${isWinner} THEN cf_attribution.avg_loser_pnl
        ELSE
          (cf_attribution.avg_loser_pnl * cf_attribution.losers_blocked + ${absPnl})
            / NULLIF(cf_attribution.losers_blocked + 1, 0)
      END,
      saved_usd = cf_attribution.saved_usd + ${isWinner ? 0 : absPnl},
      lost_usd  = cf_attribution.lost_usd  + ${isWinner ? absPnl : 0},
      net_usd   = cf_attribution.net_usd   + ${isWinner ? -absPnl : absPnl},
      window_end_ts = ${windowEndTs}
  `);
}

/**
 * Return aggregated FilterAttribution rows for the engine. Aggregates across
 * all windows within windowHours. sport=null → global rows; provide `sport`
 * to filter to one sport.
 */
export async function getAttribution(
  windowHours = 24,
  sport: string | null = null,
): Promise<FilterAttribution[]> {
  const db = getDb();
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;

  const sportFilter = sport === null
    ? sql`sport IS NULL`
    : sql`sport = ${sport}`;

  type AttrRow = {
    reject_key: string;
    sport: string | null;
    reject_count: number;
    data_points: number;
    winners_blocked: number;
    losers_blocked: number;
    avg_winner_pnl: number;
    avg_loser_pnl: number;
    saved_usd: number;
    lost_usd: number;
    net_usd: number;
  };
  const rows = (await db.execute(sql`
    SELECT
      reject_key,
      sport,
      sum(reject_count)::int AS reject_count,
      sum(data_points)::int  AS data_points,
      sum(winners_blocked)::int AS winners_blocked,
      sum(losers_blocked)::int  AS losers_blocked,
      CASE WHEN sum(winners_blocked) > 0
        THEN sum(avg_winner_pnl * winners_blocked) / sum(winners_blocked)
        ELSE 0 END AS avg_winner_pnl,
      CASE WHEN sum(losers_blocked) > 0
        THEN sum(avg_loser_pnl * losers_blocked) / sum(losers_blocked)
        ELSE 0 END AS avg_loser_pnl,
      sum(saved_usd) AS saved_usd,
      sum(lost_usd)  AS lost_usd,
      sum(net_usd)   AS net_usd
    FROM cf_attribution
    WHERE window_end_ts >= ${sinceMs}
      AND ${sportFilter}
    GROUP BY reject_key, sport
  `)) as unknown as AttrRow[];

  return rows.map<FilterAttribution>((r: AttrRow) => ({
    rejectKey: r.reject_key,
    configKey: REJECT_TO_CONFIG[r.reject_key] ?? r.reject_key,
    humanName: HUMAN_NAMES[r.reject_key] ?? r.reject_key,
    phase: REJECT_PHASES[r.reject_key] ?? "entry",
    sport: r.sport,
    rejectCount: Number(r.reject_count ?? 0),
    dataPoints: Number(r.data_points ?? 0),
    winnersBlocked: Number(r.winners_blocked ?? 0),
    losersBlocked: Number(r.losers_blocked ?? 0),
    avgWinnerPnl: Number(r.avg_winner_pnl ?? 0),
    avgLoserPnl: Number(r.avg_loser_pnl ?? 0),
    saved: Number(r.saved_usd ?? 0),
    lost: Number(r.lost_usd ?? 0),
    net: Number(r.net_usd ?? 0),
  }));
}

/**
 * Median entry_cost_usd of accepted closed positions in the window, for
 * recordRejections fallback hypothetical_size.
 */
export async function medianAcceptedEntryUsd(windowMs = 24 * 60 * 60 * 1000): Promise<number> {
  const db = getDb();
  const sinceMs = Date.now() - windowMs;
  const medianRows = (await db.execute(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY entry_cost_usd) AS median
    FROM positions
    WHERE status = 'CLOSED'
      AND last_state_change_ts >= ${sinceMs}
      AND entry_cost_usd > 0
  `)) as unknown as Array<{ median: number | null }>;
  // Reference positions in code so the import isn't dead — keeps tree-shaking
  // happy and makes the dependency obvious.
  void positions;
  const v = medianRows[0]?.median;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1.0;
}
