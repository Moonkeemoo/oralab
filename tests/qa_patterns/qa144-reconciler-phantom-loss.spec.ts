/**
 * QA-144 — Reconciler phantom loss stamp.
 *
 * Pattern: reconciler stamps phantom loss when /activity returns 0 trades for
 * asset. But could be eventual consistency lag, not real phantom.
 *
 * Rule: wait 5 minutes after close before phantom-stamping. Allow grace period
 * for chain indexing.
 *
 * Out of decide_exit scope. Reconciler grace in src/monitor/reconciler.ts.
 */
import { describe, it } from "vitest";

describe("QA-144 reconciler phantom-loss grace period", () => {
  it.todo("reconciler waits 5 minutes after close before stamping phantom_loss");
  it.todo("/activity eventual-consistency 5-30s window respected");
  it.todo("phantom_loss never auto-stamped — surfaces as P1 alert for human review");
});
