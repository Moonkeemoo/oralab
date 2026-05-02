import { type Filter, PASS, SKIP } from "../types.js";

/**
 * trust_gate — whale trust score (long-term reliability). 31% skip rate in v1 audit.
 */
export const trustGate: Filter = {
  name: "trust_gate",
  description: "Min whale trust score to enter",
  evaluate(ctx, params) {
    const min = (params["minTrust"] as number | undefined) ?? 0.3;
    const v = ctx.whale.trustScore;
    if (v < min) return SKIP({ v, t: min }, "trust below threshold");
    return PASS({ v, t: min });
  },
};
