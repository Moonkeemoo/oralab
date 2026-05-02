import { type Filter, PASS, SKIP } from "../types.js";

/**
 * price_too_high — refuse to enter near-resolution prices where upside is capped.
 * 100% skip rate in v1 audit — every signal at >0.95 was killed.
 */
export const priceTooHigh: Filter = {
  name: "price_too_high",
  description: "Reject entries above ceiling — upside too thin",
  evaluate(ctx, params) {
    const max = (params["maxPrice"] as number | undefined) ?? 0.93;
    const v = ctx.signal.priceHint;
    if (v > max) return SKIP({ v, t: max }, "entry price above ceiling");
    return PASS({ v, t: max });
  },
};
