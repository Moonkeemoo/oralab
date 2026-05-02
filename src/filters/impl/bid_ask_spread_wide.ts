import { type Filter, PASS, SKIP } from "../types.js";

/**
 * bid_ask_spread_wide — INV-D2 entry-side gate. If real /book spread is too wide
 * we won't be able to exit at fair price. 100% skip rate when fired in v1 audit.
 */
export const bidAskSpreadWide: Filter = {
  name: "bid_ask_spread_wide",
  description: "Reject when (ask - bid) / midpoint exceeds threshold",
  evaluate(ctx, params) {
    const maxSpreadPct = (params["maxSpreadPct"] as number | undefined) ?? 0.15;
    const mid = (ctx.market.bid + ctx.market.ask) / 2;
    const v = mid > 0 ? (ctx.market.ask - ctx.market.bid) / mid : 1;
    if (v > maxSpreadPct) return SKIP({ v, t: maxSpreadPct }, "bid-ask spread too wide");
    return PASS({ v, t: maxSpreadPct });
  },
};
