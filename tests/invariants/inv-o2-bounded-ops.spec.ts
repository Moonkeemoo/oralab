/**
 * INV-O2 — Bounded operations: timeout + retry + idempotency.
 *
 * Every HTTP/RPC call: timeout=5s, retry 3× with exponential backoff.
 * Order placement idempotent via client_order_id. Cancel idempotent (404 = OK).
 *
 * Out of decide_exit scope: lives in src/api/* and src/execute/order_manager.ts.
 */
import { describe, it } from "vitest";

describe("INV-O2 bounded ops", () => {
  it.todo("every HTTP call has 5s timeout");
  it.todo("HTTP retries 3× with exponential backoff (200ms → 400ms → 800ms)");
  it.todo("order placement uses client_order_id for idempotency");
  it.todo("cancel returns ok on 404 (already swept/expired)");
});
