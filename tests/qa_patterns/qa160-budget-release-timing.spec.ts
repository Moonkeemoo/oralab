/**
 * QA-160 — Budget release at exit submission.
 *
 * Pattern: budget released when state transitions to "exiting" (sell submitted),
 * not at "closed". Trades in "exiting" with no closure_reason show open in
 * trade_log but spent_usd already excludes them.
 *
 * Rule: reconciler counts (exiting, resolved) as released; only OPEN counts as
 * committed.
 *
 * Out of decide_exit scope. Budget reconciliation in src/execute/budget.ts.
 */
import { describe, it } from "vitest";

describe("QA-160 budget release on EXITING transition", () => {
  it.todo("budget_committed_usd = sum(entry_costs) where status === OPEN");
  it.todo("budget_released_usd = sum(entry_costs) where status IN (EXITING, RESOLVED, CLOSED)");
  it.todo("dashboard shows pending exits in 'releasing' bucket, not 'open'");
});
