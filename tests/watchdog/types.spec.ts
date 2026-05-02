import { describe, expect, it } from "vitest";
import { ALERT, OK } from "../../src/watchdog/types.js";

describe("WatchdogRule helpers", () => {
  it("OK shape", () => {
    const r = OK();
    expect(r).toEqual({ ok: true });
  });

  it("ALERT carries severity + message + optional fields", () => {
    const r = ALERT("P0", "boom", { x: 1 });
    expect(r).toEqual({ ok: false, severity: "P0", message: "boom", fields: { x: 1 } });
  });

  it("ALERT without fields", () => {
    const r = ALERT("P1", "warn");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe("P1");
  });
});
