import process from "node:process";
import { pino } from "pino";

const level =
  process.env["LOG_LEVEL"] ?? (process.env["NODE_ENV"] === "production" ? "info" : "debug");
const service = process.env["OTEL_SERVICE_NAME"] ?? "ora2";

export const logger = pino({
  level,
  base: { service },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      "*.privateKey",
      "*.POLY_PRIVATE_KEY",
      "*.POLY_API_SECRET",
      "*.POLY_API_PASSPHRASE",
      "*.signature",
      "*.token",
    ],
    remove: true,
  },
});

export type Logger = typeof logger;

export function child(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
