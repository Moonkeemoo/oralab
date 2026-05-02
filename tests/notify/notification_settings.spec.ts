import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no db in test");
  },
}));

import { isNotificationEnabled } from "../../src/notify/notification_settings.js";

describe("isNotificationEnabled", () => {
  it("defaults to true when DB read throws", async () => {
    expect(await isNotificationEnabled(1, "buy_placed")).toBe(true);
  });
});
