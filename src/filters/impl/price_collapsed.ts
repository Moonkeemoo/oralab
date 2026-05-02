import { type Filter, PASS, SKIP } from "../types.js";

/**
 * price_collapsed — reject signals on outcomes whose own price has
 * collapsed near 0 or pinned near 1 (already-decided/dead markets).
 *
 * Distinct from price_too_high / price_too_low which are tied to the
 * strategy budget ceiling/floor for sizing — this targets markets where
 * the signal *itself* indicates the outcome has already been resolved
 * by the market, regardless of strategy budget. Loosely ported from v1
 * price_quality.PriceCollapsedFilter (v1 measured move from whale->now;
 * v2 has only signal.priceHint so we use absolute price band).
 */
const DEFAULT_MIN_PRICE = 0.02;
const DEFAULT_MAX_PRICE = 0.98;

export const priceCollapsed: Filter = {
  name: "price_collapsed",
  description: "Reject signals where price collapsed toward 0 or pinned toward 1",
  evaluate(ctx, params) {
    const minPrice = Number(params["minPrice"] ?? DEFAULT_MIN_PRICE);
    const maxPrice = Number(params["maxPrice"] ?? DEFAULT_MAX_PRICE);
    const v = ctx.signal.priceHint;
    if (v <= minPrice) return SKIP({ v, t: minPrice }, "price collapsed toward 0");
    if (v >= maxPrice) return SKIP({ v, t: maxPrice }, "price pinned toward 1");
    return PASS({ v, t: maxPrice });
  },
};
