import { inArray } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { positions } from "../../db/schema.js";
import { ALERT, OK, type WatchdogRule } from "../types.js";

/**
 * R9 — Budget drift detector. INV-M4 backstop.
 *
 *   sum(entry_costs WHERE status=OPEN) ≤ strategy.params.budgetUsd × 1.005
 *
 * 0.5% slack absorbs floating-point rounding. Beyond that → ALERT.
 *
 * Excludes PENDING/FAILED/FROZEN (QA-149 — never spent on chain).
 */

const COMMITTED = ["OPEN"] as const;
const DRIFT_THRESHOLD = 0.005;

export const r9BudgetDrift: WatchdogRule = {
  id: "R9",
  description: "Sum(entry_costs WHERE OPEN) must not exceed budget by > 0.5%",
  async evaluate() {
    const db = getDb();
    const allStrats = await db.query.strategies.findMany();
    for (const s of allStrats) {
      const params = (s.params as Record<string, unknown> | null) ?? {};
      const budgetUsd = Number(params["budgetUsd"] ?? 100);
      const open = await db.query.positions.findMany({
        where: inArray(positions.status, [...COMMITTED]),
      });
      const sumOpen = open
        .filter((p) => Number(p.strategyId) === Number(s.id))
        .reduce((acc, p) => acc + Number(p.entryCostUsd ?? 0), 0);
      const overshoot = (sumOpen - budgetUsd) / Math.max(budgetUsd, 1);
      if (overshoot > DRIFT_THRESHOLD) {
        return ALERT("P0", "budget drift over threshold", {
          strategyId: s.id,
          budgetUsd,
          sumOpen,
          overshootPct: overshoot,
        });
      }
    }
    return OK();
  },
};
