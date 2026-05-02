import { type Counter, type Histogram, metrics } from "@opentelemetry/api";

/**
 * Histograms tracked from Day 1 per architecture.html §06 SLO targets.
 *
 * IMPORTANT: instruments are LAZILY created on first record(). This is the
 * canonical way to side-step OTel's no-op-provider trap: meter.getHistogram()
 * binds to whatever provider is registered at call time. If we created
 * instruments at module-import we'd bind to the no-op provider before
 * startTelemetry() registers the SDK.
 */

const ms_buckets_short = [1, 5, 10, 25, 50, 100, 200, 500, 1000];
const ms_buckets_long = [50, 100, 200, 500, 1000, 2000, 3000, 5000, 10000];

function meter() {
  return metrics.getMeter("ora2");
}

function lazyHistogram(name: string, description: string, buckets: readonly number[]): Histogram {
  let inst: Histogram | null = null;
  return {
    record(value: number, attributes?: Parameters<Histogram["record"]>[1]) {
      if (!inst) {
        inst = meter().createHistogram(name, {
          description,
          advice: { explicitBucketBoundaries: [...buckets] },
        });
      }
      inst.record(value, attributes);
    },
  } as Histogram;
}

function lazyCounter(name: string, description: string): Counter {
  let inst: Counter | null = null;
  return {
    add(value: number, attributes?: Parameters<Counter["add"]>[1]) {
      if (!inst) inst = meter().createCounter(name, { description });
      inst.add(value, attributes);
    },
  } as Counter;
}

export const whaleToBuyLatencyMs = lazyHistogram(
  "whale_to_buy_latency_ms",
  "End-to-end: whale fill detected → our BUY accepted by CLOB",
  ms_buckets_long,
);

export const decideExitDurationMs = lazyHistogram(
  "decide_exit_duration_ms",
  "decide_exit pure function execution time — should always be tiny",
  ms_buckets_short,
);

export const positionMonitorTickMs = lazyHistogram(
  "position_monitor_tick_ms",
  "Full position monitor tick: snap fetch + decide_exit + (if exit) place order",
  ms_buckets_short,
);

export const orderPlacementDurationMs = lazyHistogram(
  "order_placement_duration_ms",
  "createAndPostOrder / createAndPostMarketOrder HTTP round-trip",
  ms_buckets_long,
);

export const orderPlacementOutcome = lazyCounter(
  "order_placement_outcome_total",
  "Counter by outcome (success | rejected | error_code) for order placement",
);

export const reconciliationDriftPct = lazyHistogram(
  "reconciliation_drift_pct",
  "DB ↔ chain drift fraction at reconciliation tick (0.05 = 5%)",
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5],
);

export const entryMutexWaitMs = lazyHistogram(
  "entry_mutex_wait_ms",
  "Time spent waiting on per-(user, strategy) entry mutex before routeInner",
  [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
);

export const entryRouteOutcome = lazyCounter(
  "entry_route_outcome_total",
  "Counter by accepted | reject_reason for routeWhaleBuy decisions",
);

/**
 * Helper to time a synchronous fn and record into a histogram.
 */
export function timeSync<T>(histogram: Histogram, fn: () => T, attrs?: Record<string, string>): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    histogram.record(performance.now() - start, attrs);
  }
}

/**
 * Helper to time an async fn and record into a histogram.
 */
export async function timeAsync<T>(
  histogram: Histogram,
  fn: () => Promise<T>,
  attrs?: Record<string, string>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    histogram.record(performance.now() - start, attrs);
  }
}
