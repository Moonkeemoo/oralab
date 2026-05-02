/**
 * QA-181 — Premature closure_reason orphans position.
 *
 * V1 wrote entry.closure_reason = reason immediately after bridge accepted GTD,
 * before on-chain fill. GTD expired CANCELED, position still on chain, but
 * local DB shows closure_reason → dashboard hides it, exit_eval skips.
 *
 * Rule: closure_reason write only after /activity shows our SELL tx, never on
 * bridge accept. This is an executor/lifecycle concern, not decide_exit.
 */
import { describe, it } from "vitest";

describe("QA-181 closure_reason gated on chain fill", () => {
  it.todo("ExitExecutor must NOT write closure_reason on order placement success");
  it.todo("ExitExecutor writes closure_reason ONLY after /activity confirms SELL tx hash");
  it.todo("FillReconciler is the sole writer of closure_reason on SELL fill events");
  it.todo("GTD expired CANCELED does NOT clear position — next tick re-evaluates");
});
