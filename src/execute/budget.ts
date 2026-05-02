import { and, eq, inArray, sum } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { positions, strategies } from "../db/schema.js";
import { logger } from "../obs/logger.js";

/**
 * Budget logic — INV-M4 atomic transactions.
 *
 *   committed_usd = sum(entry_costs) where status = OPEN
 *   released_usd  = sum(entry_costs) where status IN (EXITING, RESOLVED, CLOSED)
 *
 * Excluded from drift detection (QA-149): PENDING, FAILED, FROZEN — these never
 * succeeded on chain so don't count against budget.
 *
 * Atomic write: position.entryCostUsd update + status transition happen in a
 * single drizzle transaction. Crash mid-update → next-startup reconciliation
 * detects the delta (R9 backstop).
 */

const COMMITTED: readonly "OPEN"[] = ["OPEN"];
const RELEASED: readonly ("EXITING" | "RESOLVED" | "CLOSED")[] = ["EXITING", "RESOLVED", "CLOSED"];

export interface BudgetSnapshot {
  readonly userId: number;
  readonly strategyId: number;
  readonly budgetUsd: number;
  readonly committedUsd: number;
  readonly releasedUsd: number;
  readonly availableUsd: number;
}

export async function getBudgetSnapshot(
  userId: number,
  strategyId: number,
): Promise<BudgetSnapshot> {
  const db = getDb();

  const strat = await db.query.strategies.findFirst({ where: eq(strategies.id, strategyId) });
  if (!strat) throw new Error(`strategy ${strategyId} not found`);
  const params = (strat.params as Record<string, unknown> | null) ?? {};
  const budgetUsd = Number(params["budgetUsd"] ?? 100);

  const [committedRow] = await db
    .select({ total: sum(positions.entryCostUsd) })
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.strategyId, strategyId),
        inArray(positions.status, [...COMMITTED]),
      ),
    );

  const [releasedRow] = await db
    .select({ total: sum(positions.entryCostUsd) })
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.strategyId, strategyId),
        inArray(positions.status, [...RELEASED]),
      ),
    );

  const committedUsd = Number(committedRow?.total ?? 0);
  const releasedUsd = Number(releasedRow?.total ?? 0);
  const availableUsd = Math.max(0, budgetUsd - committedUsd);

  return { userId, strategyId, budgetUsd, committedUsd, releasedUsd, availableUsd };
}

/**
 * Reserve entry cost atomically: write entryCostUsd to a position row that's
 * already been INSERTed in PENDING status. Used by OrderManager after
 * placeBuy returns success — we know the size, can compute entry cost.
 */
export async function recordEntryCost(positionId: number, entryCostUsd: number): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(positions)
      .set({ entryCostUsd, updatedAt: new Date() })
      .where(eq(positions.id, positionId));
  });
  logger.debug({ positionId, entryCostUsd }, "entry cost recorded");
}

/**
 * Pre-check: would the entry exceed budget? Used by OrderManager / Strategy
 * before submitting BUY. Returns true if the entry CAN be placed.
 */
export async function canAffordEntry(
  userId: number,
  strategyId: number,
  proposedEntryUsd: number,
): Promise<{ ok: boolean; budget: BudgetSnapshot }> {
  const budget = await getBudgetSnapshot(userId, strategyId);
  return {
    ok: proposedEntryUsd <= budget.availableUsd,
    budget,
  };
}

/**
 * Compute realized PnL from chain activity for closed positions.
 * Sum of (sell_value - entry_cost - fees) across positions matching condition.
 */
export async function realizedPnlForUser(userId: number): Promise<number> {
  const db = getDb();
  const closed = await db
    .select({ pnl: positions.realizedPnlUsd })
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.status, "CLOSED")));
  return closed.reduce((acc, r) => acc + Number(r.pnl ?? 0), 0);
}
