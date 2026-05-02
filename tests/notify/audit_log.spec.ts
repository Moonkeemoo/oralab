import { describe, expect, it, vi } from "vitest";

interface AuditMock {
  insertMock: ReturnType<typeof vi.fn>;
  valuesMock: ReturnType<typeof vi.fn>;
}

vi.mock("../../src/db/client.js", () => {
  const insertMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn((_v: unknown) => ({}));
  const dbStub = {
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        valuesMock(v);
        return insertMock();
      },
    })),
  };
  (globalThis as unknown as { __auditMock: AuditMock }).__auditMock = {
    insertMock,
    valuesMock,
  };
  return { getDb: () => dbStub };
});

import { writeAudit } from "../../src/notify/audit_log.js";

const m = (globalThis as unknown as { __auditMock: AuditMock }).__auditMock;

describe("writeAudit", () => {
  it("inserts a row with provided fields", async () => {
    await writeAudit({
      actor: "mini_app",
      userId: 61804306,
      action: "kill_switch_on",
      target: "global",
      payload: { reason: "test" },
    });
    expect(m.valuesMock).toHaveBeenCalled();
    const v = m.valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(v["actor"]).toBe("mini_app");
    expect(v["action"]).toBe("kill_switch_on");
    expect(v["target"]).toBe("global");
    expect(v["payload"]).toEqual({ reason: "test" });
    expect(typeof v["ts"]).toBe("number");
  });

  it("swallows db errors (never throws into caller)", async () => {
    const dbStub = {
      insert: () => ({ values: () => Promise.reject(new Error("db down")) }),
    };
    vi.doMock("../../src/db/client.js", () => ({ getDb: () => dbStub }));
    await expect(
      writeAudit({ actor: "test", action: "x", target: null, payload: {} }),
    ).resolves.toBeUndefined();
  });
});
