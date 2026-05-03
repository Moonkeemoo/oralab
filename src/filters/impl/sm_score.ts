import { type Filter, PASS, SKIP } from "../types.js";

/**
 * sm_score — signal-to-market score, weighting whale move vs market depth.
 * 91% skip rate in v1 audit — likely tight threshold; review for tuning.
 */
export const smScore: Filter = {
  name: "sm_score",
  description: "Signal-to-market score floor",
  evaluate(ctx, params) {
    const min = Number(params["min"] ?? params["minSmScore"] ?? 0);
    const v = ctx.whale.smScore;
    if (v < min) return SKIP({ v, t: min }, "sm_score below threshold");
    return PASS({ v, t: min });
  },
};
