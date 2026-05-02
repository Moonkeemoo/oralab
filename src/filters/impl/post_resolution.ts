import { type Filter, PASS, SKIP } from "../types.js";

/**
 * post_resolution — reject signals after market end date.
 * Ported from v1 hard_safety.PostResolutionEntryFilter.
 *
 * Reads endDate from `ctx.market.endDate` (canonical, populated by gamma
 * fetch in routeInner). Also falls back to `signal.payload.endDate` /
 * `marketEndDate` if some upstream path stashed it there. No-op if all
 * three are absent or unparseable.
 */
export const postResolution: Filter = {
  name: "post_resolution",
  description: "Reject entries after market endDate has passed",
  evaluate(ctx, _params) {
    const market = ctx.market as unknown as Record<string, unknown> | null | undefined;
    const payload = ctx.signal.payload as Record<string, unknown>;
    const endDateRaw =
      (market && (market["endDate"] ?? market["endDateTs"])) ??
      payload["endDate"] ??
      payload["marketEndDate"] ??
      null;
    if (!endDateRaw) return PASS({ v: 0, t: 0 });

    const endTs =
      typeof endDateRaw === "string" ? Date.parse(endDateRaw) : Number(endDateRaw);
    if (!Number.isFinite(endTs) || endTs <= 0) {
      return PASS({ v: 0, t: 0 });
    }

    if (ctx.nowMs > endTs) {
      const overSec = (ctx.nowMs - endTs) / 1000;
      return SKIP({ v: overSec, t: 0 }, `market end was ${overSec.toFixed(0)}s ago`);
    }
    return PASS({ v: 0, t: 0 });
  },
};
