import { type Filter, PASS, SKIP } from "../types.js";

/**
 * max_open_positions — concurrent position cap.
 * 3.6% skip rate in v1 audit — actively limiting at cap = 5.
 */
export const maxOpenPositions: Filter = {
  name: "max_open_positions",
  description: "Concurrent OPEN/EXITING position count cap",
  evaluate(ctx, params) {
    const max = (params["max"] as number | undefined) ?? 5;
    const v = ctx.account.openPositions.filter(
      (p) => p.status === "OPEN" || p.status === "EXITING",
    ).length;
    if (v >= max) return SKIP({ v, t: max }, "open position cap reached");
    return PASS({ v, t: max });
  },
};
