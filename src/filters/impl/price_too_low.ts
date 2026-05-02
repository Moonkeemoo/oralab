import { type Filter, PASS, SKIP } from "../types.js";

/**
 * price_too_low — reject entries below floor — too close to resolution=0,
 * tiny win % even on hit. v1 audit shows 0.9% skip rate.
 */
export const priceTooLow: Filter = {
  name: "price_too_low",
  description: "Reject entries below floor — long-shot territory",
  evaluate(ctx, params) {
    const min = (params["minPrice"] as number | undefined) ?? 0.05;
    const v = ctx.signal.priceHint;
    if (v < min) return SKIP({ v, t: min }, "entry price below floor");
    return PASS({ v, t: min });
  },
};
