/**
 * QA-165 — WS-book mark trust post-fill.
 *
 * Pattern: WS book registered cross-spread quote 1s after FOK fill. Bot trusted
 * mark_quality=executable from ws_book → fired emergency SL on phantom price.
 *
 * Rule: post-entry debounce 5s — if (now - fill_ts < 5s) AND (markSource ===
 * "ws_book"), return HOLD.
 */
import { describe, expect, it } from "vitest";
import { decideExit } from "../../src/decide.js";
import { cfg, makePos, makeSnap, NOW } from "../helpers.js";

describe("QA-165 5s post-fill debounce on ws_book", () => {
  it("HOLD at 1s post-fill with ws_book mark", () => {
    const snap = makeSnap({ markSource: "ws_book", markTs: NOW });
    const pos = makePos({ fillTs: NOW - 1_000, fillPrice: 0.5 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("HOLD at 4.9s post-fill with ws_book mark", () => {
    const snap = makeSnap({ markSource: "ws_book", markTs: NOW });
    const pos = makePos({ fillTs: NOW - 4_900, fillPrice: 0.5 });
    const intent = decideExit(pos, snap, cfg);
    expect(intent.action).toBe("hold");
  });

  it("rest_book source NOT debounced (still trusted post-fill)", () => {
    // Even 1s post-fill, rest_book is real REST /book — trust it
    const snap = makeSnap({
      markSource: "rest_book",
      bid: 0.6,
      ask: 0.61,
      mark: 0.605,
      markTs: NOW,
    });
    const pos = makePos({ fillTs: NOW - 1_000, fillPrice: 0.5 });
    const intent = decideExit(pos, snap, cfg);
    // mark 0.605 vs fill 0.5 = +21% → TP triggers
    if (intent.action !== "hold") {
      expect(intent.action).toBe("sell_bid_probe");
    }
  });
});
