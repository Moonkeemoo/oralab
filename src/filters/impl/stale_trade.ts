import { type Filter, PASS, SKIP } from "../types.js";

/**
 * stale_trade — gate by signal age. If whale fill detected > N seconds ago,
 * the edge is gone. 0% skip rate in v1 audit window — likely thresh-permissive,
 * but kept as guardrail.
 */
export const staleTrade: Filter = {
  name: "stale_trade",
  description: "Reject signals older than threshold seconds",
  evaluate(ctx, params) {
    const max = (params["maxAgeSec"] as number | undefined) ?? 60;
    const v = ctx.whale.signalAgeSec;
    if (v > max) return SKIP({ v, t: max }, "signal age above threshold");
    return PASS({ v, t: max });
  },
};
