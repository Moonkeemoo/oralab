/**
 * INV-M4 — Atomic budget transaction.
 *
 * Position update + entry-cost + exited-flag → single Postgres transaction.
 * Crash mid-update → next-startup reconciliation detects delta. R9 backstop.
 *
 * Out of decide_exit scope: budget logic lives in src/execute/budget.ts.
 * Tests scaffold here for tracking; implementation lands in P1 week 2-3.
 */
import { describe, it } from "vitest";

describe("INV-M4 atomic budget transaction", () => {
  it.todo("budget update + position update happen in single drizzle transaction");
  it.todo("crash mid-update: next-startup reconciler detects entry_cost delta");
  it.todo("R9 watchdog rule catches drift > $0.50 between budget and sum(entry_costs)");
  it.todo("failed/cancelled orders excluded from spent_usd (QA-149)");
  it.todo("EXITING positions counted as released (QA-160)");
});
