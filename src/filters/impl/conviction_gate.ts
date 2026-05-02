import { type Filter, PASS, SKIP } from "../types.js";

/**
 * conviction_gate — gate by whale conviction score (composite of repeat trades,
 * directional consistency, win rate). 44% skip rate in v1 audit.
 */
export const convictionGate: Filter = {
  name: "conviction_gate",
  description: "Min whale conviction score to enter",
  evaluate(ctx, params) {
    const min = (params["minConviction"] as number | undefined) ?? 0.05;
    const v = ctx.whale.convictionScore;
    if (v < min) return SKIP({ v, t: min }, "conviction below threshold");
    return PASS({ v, t: min });
  },
};
