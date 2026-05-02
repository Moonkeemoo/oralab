/**
 * End-to-end OTel smoke test.
 *
 * Critical detail: startTelemetry() MUST be called BEFORE any module that
 * calls metrics.getMeter() / trace.getTracer(). Otherwise meters/tracers bind
 * to the no-op global provider and stay no-op even after SDK starts. We use
 * dynamic import below to enforce ordering.
 */
import process from "node:process";

const PROM_URL = "http://localhost:9091";

async function queryProm(metric: string): Promise<number> {
  const res = await fetch(`${PROM_URL}/api/v1/query?query=${encodeURIComponent(metric)}`);
  const json = (await res.json()) as { data?: { result?: unknown[] } };
  return json.data?.result?.length ?? 0;
}

async function main(): Promise<void> {
  process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??= "http://localhost:4318";
  process.env["OTEL_SERVICE_NAME"] ??= "ora2-smoke";

  const tracer = await import("../src/obs/tracer.js");
  tracer.startTelemetry();

  // Dynamic import AFTER startTelemetry so the Meter binds to real provider
  const metrics = await import("../src/obs/metrics.js");
  const { logger } = await import("../src/obs/logger.js");

  for (let i = 0; i < 20; i += 1) {
    metrics.whaleToBuyLatencyMs.record(800 + Math.random() * 1500, { kind: "smoke" });
    metrics.decideExitDurationMs.record(2 + Math.random() * 30, { kind: "smoke" });
    metrics.positionMonitorTickMs.record(40 + Math.random() * 120, { kind: "smoke" });
  }

  await tracer.withSpan("smoke.parent", async () => {
    await tracer.withSpan("smoke.decide_exit", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await tracer.withSpan("smoke.place_buy", async () => {
      await new Promise((r) => setTimeout(r, 8));
    });
  });

  logger.info("smoke metrics + traces emitted");

  // Wait through 1 full export cycle (10s) + 1 scrape interval (10s) before declaring failure
  const checks = [
    "ora2_whale_to_buy_latency_ms_count",
    "ora2_decide_exit_duration_ms_count",
    "ora2_position_monitor_tick_ms_count",
  ];
  let ok = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5_000));
    ok = 0;
    for (const m of checks) {
      const s = await queryProm(m);
      if (s > 0) ok += 1;
    }
    logger.info({ attempt, ok, total: checks.length }, "polling prometheus");
    if (ok === checks.length) break;
  }

  await tracer.shutdownTelemetry();
  for (const m of checks) {
    const series = await queryProm(m);
    logger.info({ metric: m, series, status: series > 0 ? "OK" : "MISSING" }, "final");
  }
  logger.info(`smoke result: ${ok}/${checks.length} histograms reached Prometheus`);
  if (ok < checks.length) process.exitCode = 1;
}

await main();
