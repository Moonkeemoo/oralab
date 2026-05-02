import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { fills, positions } from "../db/schema.js";
import { isRuntimeKillSwitchActive } from "../notify/kill_switch.js";
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

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function createRestServer(): http.Server {
  return http.createServer(async (req, res) => {
    const log = logger.child({ component: "rest_server", url: req.url, method: req.method });
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

    if (req.url === "/api/health") return send(res, 200, { ok: true });

    const auth = authenticate(req);
    if (!auth.ok) {
      log.debug({ reason: auth.reason }, "rest_server: 401");
      return send(res, 401, { error: "unauthorized", reason: auth.reason });
    }

    try {
      if (req.url === "/api/status") return send(res, 200, await handleStatus());
      if (req.url === "/api/positions") return send(res, 200, await handlePositions());
      if (req.url?.startsWith("/api/pnl")) return send(res, 200, await handlePnl(req));
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
