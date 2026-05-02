/**
 * INV-O1 — Circuit breaker on SDK calls.
 *
 * Health check every 30s. >2 consecutive fails → block new entries; existing
 * exits via emergency path with accept_loss=true.
 *
 * Out of decide_exit scope: lives in src/api/circuit_breaker.ts. Tests scaffold
 * here for tracking; implementation lands week 2-3 alongside OrderManager.
 */
import { describe, it } from "vitest";

describe("INV-O1 circuit breaker", () => {
  it.todo("HTTP /health every 30s; >2 consecutive fails opens circuit");
  it.todo("circuit OPEN: block new BUY entries");
  it.todo("circuit OPEN: existing exits use emergency path with accept_loss=true");
  it.todo("circuit auto-resets after N seconds of healthy probe");
});
