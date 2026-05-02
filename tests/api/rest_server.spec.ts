/**
 * Tests for ora2-api init-data validation and route auth gate.
 * Endpoint handlers themselves hit DB, so they're smoke-tested separately.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateInitData } from "../../src/api/rest_server.js";

function signedInitData(token: string, fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("validateInitData (Telegram WebApp)", () => {
  const TOKEN = "test-bot-token";

  it("returns ok=false when init_data empty", () => {
    expect(validateInitData("", TOKEN).ok).toBe(false);
  });

  it("returns ok=false when bot token empty", () => {
    expect(validateInitData("query_id=abc&hash=def", "").ok).toBe(false);
  });

  it("returns ok=false when hash field absent", () => {
    expect(validateInitData("query_id=abc", TOKEN).ok).toBe(false);
  });

  it("returns ok=false on hash mismatch", () => {
    expect(validateInitData("query_id=abc&hash=wrong", TOKEN).ok).toBe(false);
  });

  it("returns ok=true on a properly-signed payload", () => {
    const initData = signedInitData(TOKEN, {
      query_id: "AAEC",
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 61804306, first_name: "Taras", username: "Moonkee" }),
    });
    const r = validateInitData(initData, TOKEN);
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(61804306);
  });

  it("ok with no user field — userId = 0", () => {
    const initData = signedInitData(TOKEN, {
      query_id: "AAEC",
      auth_date: String(Math.floor(Date.now() / 1000)),
    });
    const r = validateInitData(initData, TOKEN);
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(0);
  });

  it("malformed user JSON tolerated (ok=true, no userId)", () => {
    const initData = signedInitData(TOKEN, {
      query_id: "AAEC",
      auth_date: "1700000000",
      user: "{not json",
    });
    const r = validateInitData(initData, TOKEN);
    expect(r.ok).toBe(true);
    expect(r.userId).toBe(0);
  });
});
