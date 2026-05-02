/**
 * Empirical tap of wss://sports-api.polymarket.com/ws.
 * Per docs: no auth, no subscribe message — auto-streams active sports
 * events. Hold for 30s, log each inbound message.
 */
import process from "node:process";
import { WebSocket } from "ws";

const url = process.env["SPORTS_WS_URL"] ?? "wss://sports-api.polymarket.com/ws";
const HOLD_MS = Number(process.env["SPORTS_TAP_MS"] ?? 30_000);

const ws = new WebSocket(url);
const start = Date.now();
const ms = (): number => Date.now() - start;
const seen = new Set<string>();

ws.on("open", () => console.log(`[${ms()}ms] open`));
ws.on("message", (data) => {
  const text = data.toString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log(`[${ms()}ms] non-JSON (${text.length}b): ${text.slice(0, 80)}`);
    return;
  }
  // Show only first message of each unique event_type / type combination
  const ev = parsed as { event_type?: string; type?: string };
  const key = `${ev.event_type ?? "?"}|${ev.type ?? "?"}`;
  const isFirst = !seen.has(key);
  if (isFirst) seen.add(key);
  const stamp = isFirst ? "FIRST" : "dup ";
  const sample = isFirst ? text.slice(0, 800) : `${key} (${text.length}b)`;
  console.log(`[${ms()}ms] ${stamp} ${sample}`);
});
ws.on("close", (code) => console.log(`[${ms()}ms] close code=${code}`));
ws.on("error", (err) => console.log(`[${ms()}ms] error: ${(err as Error).message}`));

setTimeout(() => {
  console.log(`\nseen unique event keys: ${[...seen].join(", ")}`);
  ws.close();
  setTimeout(() => process.exit(0), 200);
}, HOLD_MS);
