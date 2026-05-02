import { type Filter, PASS, SKIP } from "../types.js";

/**
 * remaining_edge — reject entries where the room from current price to
 * $1 is too small to leave any practical TP headroom.
 *
 * remaining = 1 - signal.priceHint. If remaining < minEdgeFrac the
 * upside is structurally too thin to bother (TP usually unreachable
 * before resolution).
 *
 * Ported from v1 price_quality.RemainingEdgeFilter (BUY-side only;
 * v2 P1 is BUY-only).
 */
const DEFAULT_MIN_EDGE_FRAC = 0.20;

export const remainingEdge: Filter = {
  name: "remaining_edge",
  description: "Reject when remaining price-to-$1 distance < minEdgeFrac",
  evaluate(ctx, params) {
    const minEdgeFrac = Number(params["minEdgeFrac"] ?? DEFAULT_MIN_EDGE_FRAC);
    const v = ctx.signal.priceHint;
    if (v <= 0 || v >= 1) {
      return SKIP({ v, t: minEdgeFrac }, "price out of (0,1) range");
    }
    const remaining = 1 - v;
    if (remaining < minEdgeFrac) {
      return SKIP(
        { v: remaining, t: minEdgeFrac },
        `remaining edge ${(remaining * 100).toFixed(1)}% < ${(minEdgeFrac * 100).toFixed(1)}% required`,
      );
    }
    return PASS({ v: remaining, t: minEdgeFrac });
  },
};
