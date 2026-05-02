import { type Filter, PASS, SKIP } from "../types.js";

/**
 * time_horizon_too_close — reject markets too close to resolution. Avoids
 * entering positions where there's no room for thesis to play out.
 */
export const timeHorizonTooClose: Filter = {
  name: "time_horizon_too_close",
  description: "Min hours to resolution for entry",
  evaluate(ctx, params) {
    const min = (params["minHoursToResolution"] as number | undefined) ?? 1;
    const v = ctx.market.hoursToResolution;
    if (v < min) return SKIP({ v, t: min }, "too close to resolution");
    return PASS({ v, t: min });
  },
};
