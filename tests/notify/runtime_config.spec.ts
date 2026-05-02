import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no db in test");
  },
}));

import {
  getRuntimeConfig,
  resetRuntimeConfigCache,
} from "../../src/notify/runtime_config.js";

beforeEach(() => resetRuntimeConfigCache());
afterEach(() => resetRuntimeConfigCache());

describe("getRuntimeConfig", () => {
  it("returns empty map when DB read throws (defensive)", async () => {
    const result = await getRuntimeConfig("global", "exit.");
    expect(result).toEqual({});
  });

  it("caches result for 2s (no second DB call within window)", async () => {
    const first = await getRuntimeConfig("global", "exit.");
    const second = await getRuntimeConfig("global", "exit.");
    expect(first).toEqual(second);
  });
});
