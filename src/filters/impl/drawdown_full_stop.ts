import { type Filter, PASS, SKIP } from "../types.js";

/**
 * drawdown_full_stop — account-level circuit breaker. Halts new entries when
 * portfolio drawdown crosses threshold. 0% skip rate in v1 audit window
 * (drawdown stayed shallow).
 */
export const drawdownFullStop: Filter = {
  name: "drawdown_full_stop",
  description: "Halt entries on portfolio drawdown threshold",
  evaluate(ctx, params) {
    const fullStop = (params["drawdownPctFullStop"] as number | undefined) ?? 0.35;
    const v = ctx.account.drawdownPct;
    if (v >= fullStop) return SKIP({ v, t: fullStop }, "drawdown full stop");
    return PASS({ v, t: fullStop });
  },
};
