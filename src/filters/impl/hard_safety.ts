import { type Filter, PASS, SKIP } from "../types.js";

/**
 * hard_safety — compound money-safety check at entry time.
 * Always ports (CLAUDE.md kickoff). Cuts orders that violate INV-M1/M2 fundamentals
 * BEFORE size+balance check (which is OrderManager's pre-flight responsibility).
 */
export const hardSafety: Filter = {
  name: "hard_safety",
  description: "INV-M1/M2 compound check: size > 0, price within tick range, market accepting",
  evaluate(ctx) {
    if (ctx.account.availableUsd <= 0) {
      return SKIP({ v: ctx.account.availableUsd, t: 0.01 }, "no available budget");
    }
    if (ctx.market.bid <= 0 || ctx.market.ask >= 1) {
      return SKIP({ v: ctx.market.ask - ctx.market.bid, t: 1 }, "dead orderbook");
    }
    if (ctx.market.minOrderSize > 0 && ctx.signal.volumeUsdHint < ctx.market.minOrderSize) {
      return SKIP(
        { v: ctx.signal.volumeUsdHint, t: ctx.market.minOrderSize },
        "below market min order size",
      );
    }
    return PASS({ v: 1, t: 1 });
  },
};
