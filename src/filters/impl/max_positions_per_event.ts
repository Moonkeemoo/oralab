import { type Filter, PASS, SKIP } from "../types.js";

/**
 * max_positions_per_event — cap concurrent positions per event/market.
 * Ported MVP from v1 hard_safety.MaxPositionsFilter (per-event variant).
 *
 * v2 note: OpenPositionLite doesn't carry gameId yet, so this MVP cap counts
 * by conditionId match (each market = one conditionId, so this enforces a
 * per-market cap). True per-event (multi-market same game) cap requires
 * extending OpenPositionLite + positions schema with gameId — deferred to P2c.
 */
const DEFAULT_MAX = 3;

export const maxPositionsPerEvent: Filter = {
  name: "max_positions_per_event",
  description: "Cap concurrent positions on the same conditionId (per-event MVP)",
  evaluate(ctx, params) {
    const max = Number(params["maxPerEvent"] ?? DEFAULT_MAX);
    const targetConditionId = ctx.signal.conditionId;

    const sameMarket = (ctx.account.openPositions ?? []).filter(
      (p) => p.conditionId && p.conditionId === targetConditionId,
    ).length;

    if (sameMarket >= max) {
      return SKIP(
        { v: sameMarket, t: max },
        `already ${sameMarket} positions on same conditionId (cap ${max})`,
      );
    }
    return PASS({ v: sameMarket, t: max });
  },
};
