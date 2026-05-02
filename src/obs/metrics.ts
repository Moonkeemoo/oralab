import { type Histogram, metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("ora2");

/**
 * Histograms tracked from Day 1 per architecture.html §06 SLO targets:
 *   whale_to_buy_latency_ms     p99 ≤ 3000ms (end-to-end whale fill → BUY accepted)
 *   decide_exit_duration_ms     p99 ≤ 50ms   (pure function — anything more = leaked I/O)
 *   position_monitor_tick_ms    p99 ≤ 200ms  (snap fetch + decide_exit + place if exit)
 *
 * Buckets are explicit to keep p95/p99 readable in Grafana even on small samples.
 */

const ms_buckets_short = [1, 5, 10, 25, 50, 100, 200, 500, 1000];
const ms_buckets_long = [50, 100, 200, 500, 1000, 2000, 3000, 5000, 10000];

export const whaleToBuyLatencyMs: Histogram = meter.createHistogram("whale_to_buy_latency_ms", {
  description: "End-to-end: whale fill detected → our BUY accepted by CLOB",
  unit: "ms",
  advice: { explicitBucketBoundaries: ms_buckets_long },
});

export const decideExitDurationMs: Histogram = meter.createHistogram("decide_exit_duration_ms", {
  description: "decide_exit pure function execution time — should always be tiny",
  unit: "ms",
  advice: { explicitBucketBoundaries: ms_buckets_short },
});

export const positionMonitorTickMs: Histogram = meter.createHistogram("position_monitor_tick_ms", {
  description: "Full position monitor tick: snap fetch + decide_exit + (if exit) place order",
  unit: "ms",
  advice: { explicitBucketBoundaries: ms_buckets_short },
});

export const orderPlacementDurationMs: Histogram = meter.createHistogram(
  "order_placement_duration_ms",
  {
    description: "createAndPostOrder / createAndPostMarketOrder HTTP round-trip",
    unit: "ms",
    advice: { explicitBucketBoundaries: ms_buckets_long },
  },
);

export const orderPlacementOutcome = meter.createCounter("order_placement_outcome_total", {
  description: "Counter by outcome (success | rejected | error_code) for order placement",
});

export const reconciliationDriftPct = meter.createHistogram("reconciliation_drift_pct", {
  description: "DB ↔ chain drift percent at reconciliation tick",
  unit: "%",
  advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5] },
});

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
