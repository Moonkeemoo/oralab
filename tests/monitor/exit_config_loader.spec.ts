import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/notify/runtime_config.js", () => ({
  getRuntimeConfig: vi.fn(),
}));

import { loadEffectiveExitConfig } from "../../src/monitor/exit_config_loader.js";
import { getRuntimeConfig } from "../../src/notify/runtime_config.js";
import { DEFAULT_EXIT_CONFIG } from "../../src/types/decide.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("loadEffectiveExitConfig", () => {
  it("returns defaults when no runtime overrides exist", async () => {
    (getRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const cfg = await loadEffectiveExitConfig();
    expect(cfg).toEqual(DEFAULT_EXIT_CONFIG);
  });

  it("merges runtime overrides on top of defaults", async () => {
    (getRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      "exit.stopLoss": -0.1,
      "exit.takeProfit": 0.25,
    });
    const cfg = await loadEffectiveExitConfig();
    expect(cfg.stopLoss).toBe(-0.1);
    expect(cfg.takeProfit).toBe(0.25);
    expect(cfg.stopLossEmergency).toBe(DEFAULT_EXIT_CONFIG.stopLossEmergency);
  });

  it("ignores unknown keys silently", async () => {
    (getRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      "exit.bogus": 999,
    });
    const cfg = await loadEffectiveExitConfig();
    expect(cfg).toEqual(DEFAULT_EXIT_CONFIG);
  });
});
