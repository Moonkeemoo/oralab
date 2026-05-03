import { type Filter, PASS, SKIP } from "../types.js";

/**
 * market_volume — min market liquidity to ensure exit feasibility.
 * 98% skip rate in v1 audit — most markets fail this; tighten/relax via params.
 */
export const marketVolume: Filter = {
  name: "market_volume",
  description: "Min market 24h volume / liquidity in USD",
  evaluate(ctx, params) {
    const min = Number(params["min"] ?? params["minVolumeUsd"] ?? 0);
    const v = ctx.market.volumeUsd;
    if (v < min) return SKIP({ v, t: min }, "market volume below threshold");
    return PASS({ v, t: min });
  },
};
