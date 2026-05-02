/**
 * INV-D2 — Mark staleness gate before SL/TP fires.
 *
 * decide_exit returns HOLD if:
 *   - mark_age_s > 60
 *   - bid <= 0
 *   - ask >= 1
 *   - spread/midpoint > 50%
 *   - post-fill 5s debounce on ws_book source (QA-165)
 *
 * Spread gate uses REAL /book (QA-180), never synthesized.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap, NOW } from "../helpers.js";

describe("INV-D2 mark staleness gate", () => {
  it("HOLD when mark age > 60s", () => {
    const snap = makeSnap({ markTs: NOW - 70_000 });
    const pos = makePos({ fillPrice: 0.5 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates).toContain("INV-D2");
  });

  it("HOLD when bid <= 0 (dead orderbook left side)", () => {
    const snap = makeSnap({ bid: 0, ask: 0.99 });
    const pos = makePos({ fillPrice: 0.5 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("HOLD when ask >= 1 (dead orderbook right side)", () => {
    const snap = makeSnap({ bid: 0.001, ask: 1 });
    const pos = makePos({ fillPrice: 0.5 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("HOLD on wide spread > 50% of midpoint (QA-180 dead book)", () => {
    // bid 0.01, ask 0.99 → mid 0.5, spread 0.98 → 196% — dead
    const snap = makeSnap({ bid: 0.01, ask: 0.99, mark: 0.5 });
    const pos = makePos();
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("HOLD when post-fill < 5s and markSource = ws_book (QA-165 debounce)", () => {
    const snap = makeSnap({ markSource: "ws_book", markTs: NOW });
    const pos = makePos({ fillTs: NOW - 2_000 }); // 2s post-fill
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
    expect(intent.gates.some((g) => g.includes("D2") || g.includes("165"))).toBe(true);
  });
});
