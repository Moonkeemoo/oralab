import process from "node:process";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { logger } from "./logger.js";

let _sdk: NodeSDK | null = null;
let _started = false;

export function startTelemetry(opts: { serviceName?: string } = {}): void {
  if (_started) return;
  _started = true;

  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!endpoint) {
    logger.info("OTEL_EXPORTER_OTLP_ENDPOINT not set — running with no-op telemetry");
    return;
  }

  const serviceName = opts.serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "ora2";
  const serviceVersion = process.env["OTEL_SERVICE_VERSION"] ?? "0.0.1";

  _sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  _sdk.start();
  logger.info({ endpoint, serviceName }, "telemetry started");

  process.on("SIGTERM", () => {
    void shutdownTelemetry();
  });
}

export async function shutdownTelemetry(): Promise<void> {
  if (!_sdk) return;
  try {
    await _sdk.shutdown();
    logger.info("telemetry shut down");
  } catch (err) {
    logger.error({ err }, "telemetry shutdown error");
  }
  _sdk = null;
  _started = false;
}

export const tracer = trace.getTracer("ora2");

/**
 * Run `fn` inside a span; record exception + set ERROR status on throw, then rethrow.
 * Usage:  await withSpan("decide_exit", async (span) => { span.setAttribute("user_id", 1); ... })
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Record<string, string | number | boolean> = {},
): Promise<T> {
  const span = tracer.startSpan(name);
  for (const [k, v] of Object.entries(attributes)) span.setAttribute(k, v);
  try {
    const out = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return out;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}
