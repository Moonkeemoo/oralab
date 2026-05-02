import { type Filter, PASS, SKIP } from "../types.js";

/**
 * slippage_cap — reject when live ask drifted significantly above the
 * whale's signal price. Surfaces an observable rejection in the pipeline
 * separately from any signal_router liveAsk pre-checks.
 *
 * Reads `ctx.market.ask` as the live ask. If unavailable (≤0), filter
 * passes — we never hard-block on missing data here; that's the
 * orderbook stale check's job.
 *
 * Ported from v1 price_quality.SlippageFilter (v1 used absolute diff;
 * v2 uses relative drift to keep thresholds price-band-agnostic).
 */
const DEFAULT_MAX_SLIPPAGE_FRAC = 0.10;

export const slippageCap: Filter = {
  name: "slippage_cap",
  description: "Reject if live ask drifted > maxSlippageFrac above signal price",
  evaluate(ctx, params) {
    const maxSlippageFrac = Number(params["maxSlippageFrac"] ?? DEFAULT_MAX_SLIPPAGE_FRAC);
    const signalPx = ctx.signal.priceHint;
    const ask = ctx.market.ask;
    if (signalPx <= 0 || ask <= 0) return PASS({ v: 0, t: maxSlippageFrac });

    const drift = (ask - signalPx) / signalPx;
    if (drift > maxSlippageFrac) {
      return SKIP(
        { v: drift, t: maxSlippageFrac },
        `live ask drift ${(drift * 100).toFixed(1)}% > ${(maxSlippageFrac * 100).toFixed(1)}% cap`,
      );
    }
    return PASS({ v: drift, t: maxSlippageFrac });
  },
};
