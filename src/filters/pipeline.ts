import { logger } from "../obs/logger.js";
import { getFilter } from "./registry.js";
import type { FilterContext, FilterParams, FilterValue } from "./types.js";

/**
 * Pipeline order: hard_safety FIRST (unconditional money-safety), then the
 * configured filters in registration order. Short-circuits on first skip;
 * still records every filter that ran into `filter_values` for audit/replay.
 */

export interface ConfiguredFilter {
  readonly name: string;
  readonly enabled: boolean;
  readonly params: FilterParams;
}

export interface PipelineResult {
  readonly passed: boolean;
  readonly skipReason: string | null;
  readonly filterValues: Record<string, FilterValue>;
  readonly evaluatedCount: number;
}

const PRIORITY_FIRST = ["hard_safety"];

function orderFilters(configured: readonly ConfiguredFilter[]): ConfiguredFilter[] {
  const enabledByName = new Map(
    configured.filter((c) => c.enabled).map((c) => [c.name, c] as const),
  );
  const ordered: ConfiguredFilter[] = [];
  for (const n of PRIORITY_FIRST) {
    const f = enabledByName.get(n);
    if (f) {
      ordered.push(f);
      enabledByName.delete(n);
    }
  }
  ordered.push(...enabledByName.values());
  return ordered;
}

export function runPipeline(
  ctx: FilterContext,
  configured: readonly ConfiguredFilter[],
): PipelineResult {
  const ordered = orderFilters(configured);
  const filterValues: Record<string, FilterValue> = {};
  let skipReason: string | null = null;
  let evaluated = 0;

  for (const cfg of ordered) {
    const filter = getFilter(cfg.name);
    if (!filter) {
      logger.warn({ filterName: cfg.name }, "filter not registered — skipping (treat as pass)");
      continue;
    }

    const result = filter.evaluate(ctx, cfg.params);
    filterValues[cfg.name] = result.value;
    evaluated += 1;

    if (!result.passed) {
      skipReason = cfg.name;
      logger.debug(
        { filterName: cfg.name, reason: result.reason, value: result.value },
        "pipeline skip",
      );
      break;
    }
  }

  return {
    passed: skipReason === null,
    skipReason,
    filterValues,
    evaluatedCount: evaluated,
  };
}
