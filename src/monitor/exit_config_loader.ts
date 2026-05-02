import { getRuntimeConfig } from "../notify/runtime_config.js";
import { DEFAULT_EXIT_CONFIG, type ExitConfig } from "../types/decide.js";

const KNOWN_KEYS: readonly (keyof ExitConfig)[] = [
  "stopLoss",
  "stopLossEmergency",
  "takeProfit",
  "trailActivate",
  "trailStop",
  "ceilingTpPrice",
  "minStopLossAgeSeconds",
  "markStaleSeconds",
  "postEntryDebounceSeconds",
  "outcomeFloorMultiplier",
];

export async function loadEffectiveExitConfig(): Promise<ExitConfig> {
  const overrides = await getRuntimeConfig("global", "exit.");
  const result: Record<string, number> = { ...DEFAULT_EXIT_CONFIG };
  for (const k of KNOWN_KEYS) {
    const override = overrides[`exit.${k}`];
    if (typeof override === "number" && Number.isFinite(override)) {
      result[k] = override;
    }
  }
  return result as unknown as ExitConfig;
}
