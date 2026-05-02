import { type Filter, PASS, SKIP } from "../types.js";

/**
 * whale_size_floor — reject signals where the whale's USD volume is below
 * the floor. Top skip generator in v1 audit (56% of skips).
 */
export const whaleSizeFloor: Filter = {
  name: "whale_size_floor",
  description: "Min whale volume in USD for a signal to be considered conviction-worthy",
  evaluate(ctx, params) {
    const min = (params["minWhaleVolumeUsd"] as number | undefined) ?? 50;
    const v = ctx.signal.volumeUsdHint;
    if (v < min) return SKIP({ v, t: min }, "whale volume below floor");
    return PASS({ v, t: min });
  },
};
