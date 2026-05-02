import { type Filter, PASS, SKIP } from "../types.js";

/**
 * drawdown_minimal — defensive lower-bound sanity check on account
 * drawdown. Distinct from `drawdown_full_stop` (hard kill at large
 * loss): this is the early-warning rail at small loss thresholds and
 * is mostly a passthrough used to assert pipeline ordering and to give
 * operators a visible value in /api/filters traces.
 *
 * Loosely ported from v1 risk_exposure.DrawdownMinimalFilter (which
 * activated a "minimal mode" requiring extra conviction; v2 keeps the
 * same data dependency but reduces it to a single threshold check).
 *
 * If realizedPnl/budget data is unavailable, filter passes — never block
 * on missing observability data.
 */
const DEFAULT_MIN_DRAWDOWN_PCT = -0.05;

export const drawdownMinimal: Filter = {
  name: "drawdown_minimal",
  description: "Lower-bound drawdown sanity check (early warning rail)",
  evaluate(ctx, params) {
    const minDrawdownPct = Number(params["minDrawdownPct"] ?? DEFAULT_MIN_DRAWDOWN_PCT);
    const dd = ctx.account.drawdownPct;
    if (!Number.isFinite(dd)) return PASS({ v: 0, t: minDrawdownPct });

    if (dd < minDrawdownPct) {
      return SKIP(
        { v: dd, t: minDrawdownPct },
        `drawdown ${(dd * 100).toFixed(2)}% < ${(minDrawdownPct * 100).toFixed(2)}% minimal threshold`,
      );
    }
    return PASS({ v: dd, t: minDrawdownPct });
  },
};
