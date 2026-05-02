import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { orders } from "../../db/schema.js";
import { ALERT, OK, type WatchdogRule } from "../types.js";

/**
 * R22 — Outcome floor backstop. INV-M2.
 *
 * Any successfully placed SELL order must have price ≥ tick_size.
 * (Outcome floor is enforced by decide_exit; this rule confirms post-fact
 *  that no SELL slipped through with a near-zero price.)
 */

const RECENT_STATUSES = ["LIVE", "MATCHED", "PARTIAL_FILL", "FILLED"] as const;

export const r22FloorViolation: WatchdogRule = {
  id: "R22",
  description: "Recent SELL orders must have price >= 0.001 (tick floor)",
  async evaluate() {
    const db = getDb();
    const recent = await db.query.orders.findMany({
      where: eq(orders.side, "SELL"),
      orderBy: (orders, { desc }) => [desc(orders.createdAt)],
      limit: 50,
    });
    for (const o of recent) {
      if (Number(o.price) < 0.001 && (RECENT_STATUSES as readonly string[]).includes(o.status)) {
        return ALERT("P0", "SELL placed below floor", {
          orderId: o.id,
          price: o.price,
          status: o.status,
        });
      }
    }
    return OK();
  },
};
