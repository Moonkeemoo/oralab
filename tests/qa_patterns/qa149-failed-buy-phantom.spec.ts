/**
 * QA-149 — Failed BUY phantom in budget.
 *
 * Pattern: failed BUYs (status=failed/cancelled) recorded in trades but never
 * spent on chain. Counted as "open" by R9 budget drift.
 *
 * Rule: budget drift detector excludes status in (failed, error, cancelled).
 *
 * Out of decide_exit scope. Budget logic in src/execute/budget.ts.
 */
import { describe, it } from "vitest";

describe("QA-149 failed BUY excluded from budget drift", () => {
  it.todo("budget_spent_usd excludes positions where status IN (FAILED, CLOSED-pre-fill)");
  it.todo("R9 watchdog rule respects exclusion");
});
