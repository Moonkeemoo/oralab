import { type Filter, PASS, SKIP } from "../types.js";

/**
 * recent_reject_cache — short-term per-asset rejection memo.
 *
 * After a signal is rejected for any reason, callers SHOULD record the
 * rejection here via `recordRecentReject(assetId)`. Within `cooldownSec`
 * any further signal on the same asset will short-circuit to SKIP — this
 * dampens whale-WS storms that re-emit the same trade many times in a
 * narrow window before the upstream filter conditions change.
 *
 * Ported from v1 hard_safety.RecentlyRejectedCacheFilter (which keyed on
 * condition_id; v2 keys on assetId because the pipeline already runs
 * per-outcome).
 *
 * State: module-level Map. Tests must call `__resetRecentRejectCache()`
 * between cases to keep behaviour deterministic.
 */
const DEFAULT_COOLDOWN_SEC = 60;

interface CacheEntry {
  readonly tsMs: number;
}

const cache = new Map<string, CacheEntry>();

export function recordRecentReject(assetId: string, nowMs = Date.now()): void {
  if (!assetId) return;
  cache.set(assetId, { tsMs: nowMs });
}

/** Test-only: reset module state between cases. */
export function __resetRecentRejectCache(): void {
  cache.clear();
}

export const recentRejectCache: Filter = {
  name: "recent_reject_cache",
  description: "Skip signals on assets that were recently rejected (storm dampener)",
  evaluate(ctx, params) {
    const cooldownSec = Number(params["cooldownSec"] ?? DEFAULT_COOLDOWN_SEC);
    if (cooldownSec <= 0) return PASS({ v: 0, t: 0 });

    const assetId = ctx.signal.assetId;
    const entry = cache.get(assetId);
    if (!entry) return PASS({ v: 0, t: cooldownSec });

    const ageSec = (ctx.nowMs - entry.tsMs) / 1000;
    if (ageSec >= cooldownSec) {
      cache.delete(assetId);
      return PASS({ v: ageSec, t: cooldownSec });
    }
    return SKIP(
      { v: ageSec, t: cooldownSec },
      `asset rejected ${ageSec.toFixed(0)}s ago < ${cooldownSec}s cooldown`,
    );
  },
};
