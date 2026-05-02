/**
 * QA-156 — Pre-sell balance threshold too loose.
 *
 * Pattern: bot used 95% threshold for "tracked vs on-chain", let through orders
 * that overshoot real balance.
 *
 * Rule: threshold 99.5%; if tracked_size > on_chain * 1.005, cap to on_chain.
 *
 * Out of decide_exit scope (executor pre-flight). decide_exit's piece is in
 * INV-M1: cap intent.size to onChainShares.
 */
import { describe, it } from "vitest";

describe("QA-156 pre-sell balance threshold", () => {
  it.todo("OrderManager pre-flight rejects when tracked_size > on_chain * 1.005");
  it.todo("OrderManager caps order.size to on_chain when discrepancy < 0.5%");
});
