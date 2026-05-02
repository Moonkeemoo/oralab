import { eq } from "drizzle-orm";
import { getActivity } from "../../api/data.js";
import { getDb } from "../../db/client.js";
import { wallets } from "../../db/schema.js";
import { ALERT, OK, type WatchdogRule } from "../types.js";

/**
 * R21 — Oversell guard. INV-M1 backstop.
 *
 * For each (asset_id) seen in /activity over last 24h:
 *   sum(SELL.size) MUST be ≤ sum(BUY.size)
 *
 * Strict inequality fail = we sold more than we bought; immediate P0 + KILL.
 */

export const r21Oversell: WatchdogRule = {
  id: "R21",
  description: "Per-asset 24h chain SELL volume must not exceed BUY volume",
  async evaluate() {
    const db = getDb();
    const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    const w = await db.query.wallets.findFirst({ where: eq(wallets.userId, 1) });
    if (!w) return OK();
    const activity = await getActivity(w.address, { limit: 500 });
    const recent = activity.filter((a) => a.timestamp * 1000 >= sinceMs);
    const byAsset = new Map<string, { buy: number; sell: number }>();
    for (const a of recent) {
      const e = byAsset.get(a.asset) ?? { buy: 0, sell: 0 };
      if (a.side === "BUY") e.buy += a.size;
      else e.sell += a.size;
      byAsset.set(a.asset, e);
    }
    for (const [asset, e] of byAsset) {
      if (e.sell > e.buy + 1e-6) {
        return ALERT("P0", "oversell detected on asset", { asset, buy: e.buy, sell: e.sell });
      }
    }
    return OK();
  },
};
