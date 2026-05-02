import { type Filter, PASS, SKIP } from "../types.js";

/**
 * intraday_binary — reject short-cycle binary markets unsuitable for whale-follow.
 * Ported from v1 hard_safety.IntradayBinaryFilter (regex catalog).
 *
 * Two patterns: INTRADAY_RE for short-time window markets, CRYPTO_BINARY_RE for
 * crypto coin-flip "BTC up by Friday"-style markets.
 */
const INTRADAY_RE = /\b(intraday|hourly|next \d+ hour|midday|today|tonight)\b/i;
const CRYPTO_BINARY_RE =
  /\b(btc|eth|sol|crypto|bitcoin|ethereum|solana)\b.*(?:up|down|above|below|cross|hit) /i;

export const intradayBinary: Filter = {
  name: "intraday_binary",
  description: "Reject intraday-binary + crypto coin-flip markets via title regex",
  evaluate(ctx, params) {
    const enabled = params["enabled"] !== false;
    if (!enabled) return PASS({ v: 0, t: 0 });

    const title = String(ctx.signal.payload["title"] ?? "");
    if (INTRADAY_RE.test(title)) {
      return SKIP({ v: 1, t: 0 }, `intraday pattern in title: ${title.slice(0, 60)}`);
    }
    if (CRYPTO_BINARY_RE.test(title)) {
      return SKIP({ v: 1, t: 0 }, `crypto-binary pattern in title: ${title.slice(0, 60)}`);
    }
    return PASS({ v: 0, t: 0 });
  },
};
