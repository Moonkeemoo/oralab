import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { decisions, fills, positions } from "../db/schema.js";
import { isRuntimeKillSwitchActive, setRuntimeKillSwitch } from "../notify/kill_switch.js";
import { logger } from "../obs/logger.js";

/**
 * ora2-api — minimal REST server for the Mini App (P2a deliverable).
 *
 * Endpoints (JSON, GET only in P2a):
 *   GET /api/status     — runtime mode, kill_switch, active counts
 *   GET /api/positions  — active positions list
 *   GET /api/pnl?windowHours=24  — closed-trade P&L aggregation
 *
 * Auth: every request must carry an `X-Telegram-Init-Data` header that
 * validates against TELEGRAM_BOT_TOKEN per the Telegram Mini App spec
 * (HMAC SHA256 of sorted init_data fields, secret = SHA256("WebAppData",
 * bot_token)). Requests without valid init_data return 401.
 *
 * Bypass for local dev: header `X-Dev-Bypass: <DEV_AUTH_TOKEN env>`.
 *
 * Listens on REST_PORT (default 8081). No HTTPS terminator built in —
 * deploy behind Caddy / nginx with TLS in front.
 */

const ACTIVE_STATUSES = ["PENDING", "FILLED", "OPEN", "EXITING"] as const;
const PORT = Number(process.env["REST_PORT"] ?? 8081);

interface InitDataValidation {
  ok: boolean;
  userId?: number;
  reason?: string;
}

/**
 * Validate Telegram WebApp init_data signature.
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string, botToken: string): InitDataValidation {
  if (!initData || !botToken) return { ok: false, reason: "missing_init_or_token" };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return { ok: false, reason: "no_hash" };
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const expectedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");
    if (expectedHash !== hash) return { ok: false, reason: "hash_mismatch" };
    const userJson = params.get("user");
    let userId: number | undefined;
    if (userJson) {
      try {
        const u = JSON.parse(userJson) as { id?: number };
        if (typeof u.id === "number") userId = u.id;
      } catch {
        // ignore
      }
    }
    return { ok: true, userId: userId ?? 0 };
  } catch (err) {
    return { ok: false, reason: `validation_error: ${(err as Error).message}` };
  }
}

function authenticate(req: http.IncomingMessage): InitDataValidation {
  const devBypass = process.env["DEV_AUTH_TOKEN"];
  if (devBypass && req.headers["x-dev-bypass"] === devBypass) {
    return { ok: true, userId: 1 };
  }
  const initData = String(req.headers["x-telegram-init-data"] ?? "");
  const token = process.env["TELEGRAM_BOT_TOKEN"] ?? "";
  return validateInitData(initData, token);
}

async function handleStatus(): Promise<unknown> {
  const db = getDb();
  const active = await db.query.positions.findMany({
    where: inArray(positions.status, [...ACTIVE_STATUSES]),
    columns: { id: true, status: true },
  });
  const ks = await isRuntimeKillSwitchActive();
  const dryRun = (process.env["DRY_RUN"] ?? "true").toLowerCase() === "true";
  return {
    mode: dryRun ? "DRY" : "LIVE",
    killSwitch: ks,
    activePositions: active.length,
    byStatus: active.reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

async function handlePositions(): Promise<unknown> {
  const db = getDb();
  const rows = await db.query.positions.findMany({
    where: inArray(positions.status, [...ACTIVE_STATUSES]),
    orderBy: desc(positions.id),
    limit: 50,
  });
  return rows.map((p) => ({
    id: p.id,
    status: p.status,
    conditionId: p.conditionId,
    assetId: p.assetId,
    side: p.side,
    shares: Number(p.shares ?? 0),
    fillPrice: Number(p.fillPrice ?? 0),
    peakPrice: Number(p.peakPrice ?? 0),
    sweepCount: p.sweepCount,
    fillTs: Number(p.fillTs ?? 0),
    entryCostUsd: Number(p.entryCostUsd ?? 0),
  }));
}

async function handlePnl(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  const closed = await db.query.positions.findMany({
    where: and(
      eq(positions.status, "CLOSED"),
      gte(positions.lastStateChangeTs, sinceMs),
    ),
  });
  let totalEntry = 0;
  let totalExit = 0;
  const breakdown = [] as { id: number; closeReason: string | null; pnlUsd: number; pnlPct: number }[];
  for (const p of closed) {
    const sells = await db.query.fills.findMany({ where: eq(fills.positionId, Number(p.id)) });
    const sellSum = sells
      .filter((f) => f.side === "SELL")
      .reduce((s, f) => s + Number(f.shares ?? 0) * Number(f.price ?? 0), 0);
    const entry = Number(p.entryCostUsd ?? 0);
    const pnl = sellSum - entry;
    totalEntry += entry;
    totalExit += sellSum;
    breakdown.push({
      id: Number(p.id),
      closeReason: p.closeReason,
      pnlUsd: pnl,
      pnlPct: entry > 0 ? pnl / entry : 0,
    });
  }
  return {
    windowHours,
    closedCount: closed.length,
    totalEntryUsd: totalEntry,
    totalExitUsd: totalExit,
    netPnlUsd: totalExit - totalEntry,
    netPnlPct: totalEntry > 0 ? (totalExit - totalEntry) / totalEntry : 0,
    breakdown,
  };
}

async function handlePositionById(id: number): Promise<unknown> {
  const db = getDb();
  const p = await db.query.positions.findFirst({
    where: eq(positions.id, id),
  });
  if (!p) return null;
  return {
    id: p.id,
    status: p.status,
    conditionId: p.conditionId,
    assetId: p.assetId,
    side: p.side,
    shares: Number(p.shares ?? 0),
    fillPrice: Number(p.fillPrice ?? 0),
    peakPrice: Number(p.peakPrice ?? 0),
    sweepCount: p.sweepCount,
    fillTs: Number(p.fillTs ?? 0),
    lastStateChangeTs: Number(p.lastStateChangeTs ?? 0),
    entryCostUsd: Number(p.entryCostUsd ?? 0),
    closeReason: p.closeReason,
    closeTxHash: p.closeTxHash,
  };
}

async function handlePositionTimeline(id: number): Promise<unknown> {
  const db = getDb();
  const p = await db.query.positions.findFirst({
    where: eq(positions.id, id),
  });
  if (!p) return { error: "not_found" };

  const fillRows = await db.query.fills.findMany({ where: eq(fills.positionId, id) });
  const decisionRows = await db.query.decisions.findMany({
    where: eq(decisions.positionId, id),
    orderBy: (cols, { desc }) => [desc(cols.ts)],
    limit: 10,
  });

  return {
    position: await handlePositionById(id),
    fills: fillRows.map((f) => ({
      side: f.side,
      shares: Number(f.shares ?? 0),
      price: Number(f.price ?? 0),
      txHash: f.txHash,
      ts: Number(f.ts ?? 0),
    })),
    recentDecisions: decisionRows.map((d) => ({
      ts: Number(d.ts),
      action: (d.outputIntent as Record<string, unknown>)["action"],
      reason: (d.outputIntent as Record<string, unknown>)["reason"],
      gates: d.gates,
      durationMs: d.durationMs,
    })),
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// ── Static /app/* — Mini App served from same origin (no CORS) ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..", "..", "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!req.url?.startsWith("/app")) return false;
  let rel = req.url.slice(4); // strip "/app"
  if (rel === "" || rel === "/") rel = "/index.html";
  // Prevent path traversal
  const fullPath = path.normalize(path.join(WEB_ROOT, rel));
  if (!fullPath.startsWith(WEB_ROOT)) {
    send(res, 403, { error: "forbidden" });
    return true;
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    send(res, 404, { error: "not_found" });
    return true;
  }
  const ext = path.extname(fullPath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  // Mini App needs to embed via Telegram WebApp; allow framing.
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org");
  res.setHeader("Cache-Control", "no-cache");
  res.end(readFileSync(fullPath));
  return true;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
      if (data.length > 8192) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function handleKillSwitchPost(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { active?: boolean; reason?: string };
  await setRuntimeKillSwitch({
    active: Boolean(body.active),
    reason: body.reason ?? "mini_app",
  });
  return { ok: true, active: Boolean(body.active) };
}

export function createRestServer(): http.Server {
  return http.createServer(async (req, res) => {
    const log = logger.child({ component: "rest_server", url: req.url, method: req.method });

    // Static /app/* (Mini App) — no auth gate; the auth is on the API layer.
    if (req.method === "GET" && serveStatic(req, res)) return;

    // Public health check
    if (req.method === "GET" && req.url === "/api/health") return send(res, 200, { ok: true });

    // POST endpoints (state-changing) require auth too
    if (req.method !== "GET" && req.method !== "POST") {
      return send(res, 405, { error: "method_not_allowed" });
    }

    const auth = authenticate(req);
    if (!auth.ok) {
      log.debug({ reason: auth.reason }, "rest_server: 401");
      return send(res, 401, { error: "unauthorized", reason: auth.reason });
    }

    try {
      if (req.method === "GET") {
        if (req.url === "/api/status") return send(res, 200, await handleStatus());
        if (req.url === "/api/positions") return send(res, 200, await handlePositions());
        if (req.url?.startsWith("/api/pnl")) return send(res, 200, await handlePnl(req));
        const posIdMatch = req.url?.match(/^\/api\/positions\/(\d+)(?:\/(timeline))?$/);
        if (posIdMatch && posIdMatch[1]) {
          const id = Number(posIdMatch[1]);
          if (posIdMatch[2] === "timeline") {
            return send(res, 200, await handlePositionTimeline(id));
          }
          const result = await handlePositionById(id);
          return send(res, result === null ? 404 : 200, result ?? { error: "not_found" });
        }
      }
      if (req.method === "POST") {
        if (req.url === "/api/kill_switch") return send(res, 200, await handleKillSwitchPost(req));
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      log.error({ err }, "rest_server handler threw");
      return send(res, 500, { error: "internal", message: (err as Error).message });
    }
  });
}

export function startRestServer(): http.Server {
  const server = createRestServer();
  server.listen(PORT, () => {
    logger.info({ port: PORT }, "ora2-api REST server listening");
  });
  return server;
}
