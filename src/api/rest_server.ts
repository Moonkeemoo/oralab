import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  decisions,
  fills,
  positions,
  signals,
  signalTimings,
  strategies,
  whales,
} from "../db/schema.js";
import { placeSell } from "../execute/order_manager.js";
import { FILTER_REGISTRY } from "../filters/registry.js";
import { loadEffectiveExitConfig } from "../monitor/exit_config_loader.js";
import { writeAudit } from "../notify/audit_log.js";
import { isRuntimeKillSwitchActive, setRuntimeKillSwitch } from "../notify/kill_switch.js";
import {
  listNotificationSettings,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  setNotificationEnabled,
} from "../notify/notification_settings.js";
import { setRuntimeConfig } from "../notify/runtime_config.js";
import { logger } from "../obs/logger.js";
import {
  type ExitConfigKey,
  type StrategyParamKey,
  validateExitConfigKey,
  validateStrategyParam,
} from "./strategy_schema.js";

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

function currentMode(): "DRY" | "LIVE" {
  return (process.env["DRY_RUN"] ?? "true").toLowerCase() === "true" ? "DRY" : "LIVE";
}

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
  const mode = currentMode();
  const active = await db.query.positions.findMany({
    where: and(
      eq(positions.mode, mode),
      inArray(positions.status, [...ACTIVE_STATUSES]),
    ),
    columns: { id: true, status: true },
  });
  const ks = await isRuntimeKillSwitchActive();
  return {
    mode,
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
    where: and(
      eq(positions.mode, currentMode()),
      inArray(positions.status, [...ACTIVE_STATUSES]),
    ),
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
      eq(positions.mode, currentMode()),
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
  const p = await db.query.positions.findFirst({ where: eq(positions.id, id) });
  if (!p) return { error: "not_found" };

  const fillRows = await db.query.fills.findMany({ where: eq(fills.positionId, id) });
  const decisionRows = await db.query.decisions.findMany({
    where: eq(decisions.positionId, id),
    orderBy: (cols, { desc }) => [desc(cols.ts)],
    limit: 10,
  });

  // Initiator: most recent signal for this asset BEFORE fillTs (the trigger).
  // Fall back to most recent signal on the asset if nothing pre-fill (eg test data).
  const sigRows = await db.query.signals.findMany({
    where: and(eq(signals.assetId, p.assetId), eq(signals.userId, p.userId)),
    orderBy: (cols, { desc }) => [desc(cols.id)],
    limit: 5,
  });
  const fillTs = Number(p.fillTs ?? 0);
  const initiatorSig = sigRows.find((s) => Number(s.receivedTs) <= fillTs) ?? sigRows[0];
  const payload = (initiatorSig?.payload ?? {}) as Record<string, unknown>;

  // Convergence count: signals on same asset within ±60s of fill (any user/strategy)
  const window = 60_000;
  const sinceMs = fillTs - window;
  const untilMs = fillTs + window;
  const convergent = await db.query.signals.findMany({
    where: and(
      eq(signals.assetId, p.assetId),
      gte(signals.receivedTs, sinceMs),
    ),
    columns: { id: true, receivedTs: true },
    limit: 200,
  });
  const convergenceCount = convergent.filter((s) => Number(s.receivedTs) <= untilMs).length;

  // PnL verification source heuristic
  const sells = fillRows.filter((f) => f.side === "SELL");
  let verifSource: string;
  if (sells.length > 0) verifSource = "chain_per_trade";
  else if (p.closeReason === "sell_filled_chain_lag") verifSource = "trade_reconciler";
  else if (p.status === "CLOSED") verifSource = "manual";
  else verifSource = "unverified";

  const whaleSizeShares = payload["whaleSizeShares"];
  const whaleSizeUsd =
    typeof whaleSizeShares === "number"
      ? whaleSizeShares * Number(p.fillPrice ?? 0)
      : null;

  return {
    position: await handlePositionById(id),
    initiator: {
      whaleAddress: payload["whaleAddress"] ?? null,
      whaleSizeShares: whaleSizeShares ?? null,
      whaleSizeUsd,
      conviction: payload["convictionScore"] ?? null,
      trustScore: payload["trustScore"] ?? null,
      smScore: payload["smScore"] ?? null,
      title: payload["title"] ?? null,
      signalReceivedTs: initiatorSig ? Number(initiatorSig.receivedTs) : null,
      convergenceCount,
    },
    verification: {
      pnlSource: verifSource,
      exitTxHash: p.closeTxHash,
      anomaly: false, // populated when chain reconciler ships (Phase L)
    },
    fills: fillRows.map((f) => ({
      side: f.side,
      shares: Number(f.shares ?? 0),
      price: Number(f.price ?? 0),
      txHash: f.txHash,
      ts: Number(f.ts ?? 0),
    })),
    recentDecisions: decisionRows.map((d) => {
      const snap = (d.inputSnapshot ?? {}) as Record<string, unknown>;
      const intent = (d.outputIntent ?? {}) as Record<string, unknown>;
      const markTs = snap["markTs"];
      return {
        ts: Number(d.ts),
        action: intent["action"],
        reason: intent["reason"],
        gates: d.gates,
        durationMs: d.durationMs,
        markSource: snap["markSource"] ?? null,
        markFreshnessMs: typeof markTs === "number" ? Number(d.ts) - markTs : null,
      };
    }),
  };
}

async function handleStrategiesList(): Promise<unknown> {
  const db = getDb();
  const rows = await db.query.strategies.findMany();
  return rows.map((s) => ({
    id: s.id,
    userId: s.userId,
    kind: s.kind,
    enabled: s.enabled,
    params: s.params,
  }));
}

async function handleStrategyById(id: number): Promise<unknown> {
  const db = getDb();
  const s = await db.query.strategies.findFirst({ where: eq(strategies.id, id) });
  if (!s) return null;
  return {
    id: s.id,
    userId: s.userId,
    kind: s.kind,
    enabled: s.enabled,
    params: s.params,
  };
}

async function handleExitConfig(): Promise<unknown> {
  const cfg = await loadEffectiveExitConfig();
  return cfg;
}

async function handleHistory(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  const rows = await db.query.positions.findMany({
    where: and(
      eq(positions.mode, currentMode()),
      eq(positions.status, "CLOSED"),
      gte(positions.lastStateChangeTs, sinceMs),
    ),
    orderBy: desc(positions.id),
    limit: 200,
  });
  const enriched = await Promise.all(
    rows.map(async (p) => {
      const sells = await db.query.fills.findMany({
        where: and(eq(fills.positionId, Number(p.id)), eq(fills.side, "SELL")),
      });
      const exitUsd = sells.reduce((s, f) => s + Number(f.shares ?? 0) * Number(f.price ?? 0), 0);
      const entryUsd = Number(p.entryCostUsd ?? 0);
      const pnl = exitUsd - entryUsd;
      return {
        id: p.id,
        closeReason: p.closeReason,
        closeTs: Number(p.lastStateChangeTs ?? 0),
        entryUsd,
        exitUsd,
        pnlUsd: pnl,
        pnlPct: entryUsd > 0 ? pnl / entryUsd : 0,
        outcome: pnl >= 0 ? "win" : "loss",
      };
    }),
  );
  const wins = enriched.filter((e) => e.outcome === "win").length;
  const losses = enriched.length - wins;
  const totalEntry = enriched.reduce((s, e) => s + e.entryUsd, 0);
  const totalExit = enriched.reduce((s, e) => s + e.exitUsd, 0);
  const netPnl = totalExit - totalEntry;
  return {
    windowHours,
    aggregates: {
      trades: enriched.length,
      wins,
      losses,
      winRatePct: enriched.length > 0 ? (wins / enriched.length) * 100 : 0,
      totalEntryUsd: totalEntry,
      totalExitUsd: totalExit,
      netPnlUsd: netPnl,
      netPnlPct: totalEntry > 0 ? netPnl / totalEntry : 0,
      avgUsd: enriched.length > 0 ? netPnl / enriched.length : 0,
      bestUsd: Math.max(0, ...enriched.map((e) => e.pnlUsd)),
      worstUsd: Math.min(0, ...enriched.map((e) => e.pnlUsd)),
    },
    trades: enriched,
  };
}

async function handleFilterStats(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  const rows = await db.query.signals.findMany({
    where: gte(signals.processedAt, new Date(sinceMs)),
    columns: { accepted: true, rejectReason: true },
  });
  const total = rows.length;
  const accepted = rows.filter((r) => r.accepted).length;
  const byReason: Record<string, number> = {};
  for (const r of rows) {
    if (!r.accepted && r.rejectReason) {
      byReason[r.rejectReason] = (byReason[r.rejectReason] ?? 0) + 1;
    }
  }
  const totalRejected = total - accepted;
  const bottlenecks = Object.entries(byReason)
    .filter(([, n]) => totalRejected > 0 && n / totalRejected >= 0.3)
    .map(([k]) => k);
  return {
    windowHours,
    total,
    accepted,
    rejected: totalRejected,
    acceptRatePct: total > 0 ? (accepted / total) * 100 : 0,
    byReason,
    bottlenecks,
  };
}

async function handleFilterRegistry(): Promise<unknown> {
  return { count: FILTER_REGISTRY.length, filters: FILTER_REGISTRY };
}

async function handleWhalesList(): Promise<unknown> {
  const db = getDb();
  const rows = await db.query.whales.findMany({
    orderBy: (cols, { desc }) => [desc(cols.tracked), desc(cols.confidence)],
    limit: 200,
  });
  return rows.map((w) => ({
    address: w.address,
    classification: w.classification,
    confidence: Number(w.confidence ?? 0),
    tracked: w.tracked,
  }));
}

async function handleConnections(): Promise<unknown> {
  const db = getDb();
  const sportsLast = await db.query.sportsEvents.findMany({
    orderBy: (c, { desc }) => [desc(c.fetchedAt)],
    limit: 1,
  });
  const sigLast = await db.query.signals.findMany({
    orderBy: (c, { desc }) => [desc(c.processedAt)],
    limit: 1,
  });
  const now = Date.now();
  const sportsAgeMs = sportsLast[0]?.fetchedAt
    ? now - sportsLast[0].fetchedAt.getTime()
    : Number.POSITIVE_INFINITY;
  const sigAgeMs = sigLast[0]?.processedAt
    ? now - sigLast[0].processedAt.getTime()
    : Number.POSITIVE_INFINITY;
  return [
    {
      source: "sports_ws",
      lastEventTs: sportsLast[0]?.fetchedAt?.getTime() ?? null,
      ageMs: Number.isFinite(sportsAgeMs) ? sportsAgeMs : null,
      state: sportsAgeMs < 60_000 ? "ok" : sportsAgeMs < 300_000 ? "stale" : "down",
    },
    {
      source: "rtds_ws",
      lastEventTs: sigLast[0]?.processedAt?.getTime() ?? null,
      ageMs: Number.isFinite(sigAgeMs) ? sigAgeMs : null,
      state: sigAgeMs < 60_000 ? "ok" : sigAgeMs < 600_000 ? "stale" : "down",
    },
  ];
}

async function handlePerf(): Promise<unknown> {
  return {
    nodeVersion: process.version,
    uptimeSec: Math.round(process.uptime()),
    memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    note: "decide_exit / monitor / WS metrics aggregation deferred to P3+",
  };
}

async function handleAudit(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? 50)));
  const db = getDb();
  const rows = await db.query.auditLog.findMany({
    orderBy: (c, { desc }) => [desc(c.ts)],
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    ts: Number(r.ts),
    actor: r.actor,
    userId: r.userId,
    action: r.action,
    target: r.target,
    payload: r.payload,
  }));
}

async function handleKpi(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  const sigRows = await db.query.signals.findMany({
    where: gte(signals.processedAt, new Date(sinceMs)),
    columns: { accepted: true, rejectReason: true },
  });
  const signalsTotal = sigRows.length;
  const signalsAccepted = sigRows.filter((r) => r.accepted).length;

  const closed = await db.query.positions.findMany({
    where: and(
      eq(positions.mode, currentMode()),
      eq(positions.status, "CLOSED"),
      gte(positions.lastStateChangeTs, sinceMs),
    ),
  });
  let wins = 0;
  let totalEntry = 0;
  let totalExit = 0;
  let posPnl = 0;
  let negPnl = 0;
  let holdSec = 0;
  const equity: { ts: number; cum: number }[] = [];
  let cum = 0;
  const sorted = closed.slice().sort((a, b) => Number(a.lastStateChangeTs) - Number(b.lastStateChangeTs));
  for (const p of sorted) {
    const sells = await db.query.fills.findMany({
      where: and(eq(fills.positionId, Number(p.id)), eq(fills.side, "SELL")),
    });
    const exitUsd = sells.reduce((s, f) => s + Number(f.shares ?? 0) * Number(f.price ?? 0), 0);
    const entryUsd = Number(p.entryCostUsd ?? 0);
    const pnl = exitUsd - entryUsd;
    totalEntry += entryUsd;
    totalExit += exitUsd;
    if (pnl >= 0) {
      wins += 1;
      posPnl += pnl;
    } else {
      negPnl += -pnl;
    }
    holdSec += (Number(p.lastStateChangeTs) - Number(p.fillTs)) / 1000;
    cum += pnl;
    equity.push({ ts: Number(p.lastStateChangeTs), cum });
  }
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of equity) {
    if (e.cum > peak) peak = e.cum;
    const dd = peak - e.cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return {
    windowHours,
    passRatePct: signalsTotal > 0 ? (signalsAccepted / signalsTotal) * 100 : 0,
    signalsPerHour: signalsTotal / windowHours,
    profitFactor: negPnl > 0 ? posPnl / negPnl : posPnl > 0 ? Infinity : 0,
    winRatePct: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    avgHoldSec: closed.length > 0 ? holdSec / closed.length : 0,
    drawdownUsd: maxDrawdown,
    netPnlUsd: totalExit - totalEntry,
    closedCount: closed.length,
  };
}

async function handleBalance(): Promise<unknown> {
  const mode = currentMode();
  const db = getDb();
  // Sum active position entry costs
  const active = await db.query.positions.findMany({
    where: and(
      eq(positions.mode, mode),
      inArray(positions.status, [...ACTIVE_STATUSES]),
    ),
    columns: { entryCostUsd: true },
  });
  const allocatedUsd = active.reduce((s, p) => s + Number(p.entryCostUsd ?? 0), 0);

  if (mode === "DRY") {
    // Simulated balance: per-strategy budget sum
    const strats = await db.query.strategies.findMany({ columns: { params: true, enabled: true } });
    const totalBudget = strats
      .filter((s) => s.enabled)
      .reduce(
        (s, st) =>
          s + Number(((st.params as Record<string, unknown>) ?? {})["budgetUsd"] ?? 0),
        0,
      );
    return {
      mode: "DRY",
      pUsdAvailable: Math.max(0, totalBudget - allocatedUsd),
      allocatedUsd,
      freeUsd: Math.max(0, totalBudget - allocatedUsd),
      totalBudgetUsd: totalBudget,
      source: "strategy_budget_simulated",
    };
  }
  // LIVE: pull pUSD from CLOB
  try {
    const { getClobClient } = await import("../api/clob.js");
    const { client } = getClobClient();
    const ba = (await client.getBalanceAllowance({
      asset_type: "COLLATERAL",
    } as Parameters<typeof client.getBalanceAllowance>[0])) as { balance?: string | number };
    const microUnits = Number(ba.balance ?? 0);
    const pUsdAvailable = microUnits / 1e6;
    return {
      mode: "LIVE",
      pUsdAvailable,
      allocatedUsd,
      freeUsd: pUsdAvailable - allocatedUsd,
      totalBudgetUsd: pUsdAvailable + allocatedUsd,
      source: "clob_balance_allowance",
    };
  } catch (err) {
    return {
      mode: "LIVE",
      error: `clob balance fetch failed: ${(err as Error).message}`,
      allocatedUsd,
    };
  }
}

async function handleBuild(): Promise<unknown> {
  return {
    service: "ora2-api",
    nodeVersion: process.version,
    startedAt: process.env["ORA2_API_STARTED_AT"] ?? new Date().toISOString(),
    gitCommit: process.env["GIT_COMMIT"] ?? "dev",
  };
}

async function handleLatency(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(
    1,
    Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)),
  );
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  const rows = await db.query.signalTimings.findMany({
    where: gte(signalTimings.ts, sinceMs),
    columns: { chain: true, stage: true, durationMs: true },
    limit: 50_000,
  });
  type Bucket = { chain: string; stage: string; count: number; sum: number; max: number };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const k = `${r.chain}:${r.stage}`;
    let b = buckets.get(k);
    if (!b) {
      b = { chain: r.chain, stage: r.stage, count: 0, sum: 0, max: 0 };
      buckets.set(k, b);
    }
    b.count += 1;
    b.sum += r.durationMs;
    if (r.durationMs > b.max) b.max = r.durationMs;
  }
  const stages = [...buckets.values()]
    .map((b) => ({ ...b, avgMs: b.sum / b.count }))
    .sort((a, b) => b.avgMs - a.avgMs);
  const bottleneck = stages[0]?.stage ?? null;
  return { windowHours, stages, bottleneck };
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

async function handleStrategyParamsPost(
  id: number,
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    const r = validateStrategyParam(k as StrategyParamKey, v);
    if (!r.ok) errors[k] = r.reason ?? "invalid";
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const db = getDb();
  const existing = await db.query.strategies.findFirst({ where: eq(strategies.id, id) });
  if (!existing) return { ok: false, error: "not_found" };
  const merged = { ...((existing.params as Record<string, unknown>) ?? {}), ...body };
  await db.update(strategies).set({ params: merged }).where(eq(strategies.id, id));
  await writeAudit({
    actor: "mini_app",
    userId,
    action: "strategy_params_update",
    target: String(id),
    payload: { changed: body },
  });
  return { ok: true, id, params: merged };
}

async function handleStrategyEnabledPost(
  id: number,
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return { ok: false, error: "enabled must be boolean" };
  }
  const db = getDb();
  await db.update(strategies).set({ enabled: body.enabled }).where(eq(strategies.id, id));
  await writeAudit({
    actor: "mini_app",
    userId,
    action: body.enabled ? "strategy_enable" : "strategy_disable",
    target: String(id),
    payload: {},
  });
  return { ok: true, id, enabled: body.enabled };
}

async function handleExitConfigPost(
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as Record<string, unknown>;
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    const r = validateExitConfigKey(k as ExitConfigKey, v);
    if (!r.ok) errors[k] = r.reason ?? "invalid";
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  for (const [k, v] of Object.entries(body)) {
    await setRuntimeConfig({
      scope: "global",
      key: `exit.${k}`,
      value: v,
      setByUserId: userId || null,
    });
  }
  await writeAudit({
    actor: "mini_app",
    userId,
    action: "exit_config_update",
    target: "global",
    payload: { changed: body },
  });
  return { ok: true, applied: body };
}

async function handlePositionExitPost(
  id: number,
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { mode?: string; slippagePct?: number };
  const mode = (body.mode ?? "FAK") as "GTD" | "FOK" | "FAK";
  const slippagePct = Math.max(0, Math.min(0.5, Number(body.slippagePct ?? 0.2)));

  const db = getDb();
  const pos = await db.query.positions.findFirst({ where: eq(positions.id, id) });
  if (!pos) return { ok: false, error: "not_found" };

  const { getBookTop } = await import("../api/book.js");
  const top = await getBookTop(pos.assetId);
  const minPrice = Math.max(0.01, top.bid * (1 - slippagePct));
  const tickSize = 0.01;
  const aligned = Math.floor(minPrice / tickSize) * tickSize;

  await writeAudit({
    actor: "mini_app",
    userId,
    action: "position_manual_exit",
    target: String(id),
    payload: { mode, slippagePct, sentMinPrice: aligned },
  });

  const r = await placeSell({
    userId: pos.userId,
    tokenId: pos.assetId,
    price: aligned,
    sizeShares: Number(pos.shares ?? 0),
    tickSize,
    negRisk: false,
    expirationTs: Math.floor(Date.now() / 1000) + 120,
    orderType: mode,
    correlationId: `manual-${id}-${Date.now()}`,
  });
  return { ok: r.success, errorCode: r.errorCode, status: r.status };
}

async function handlePositionFreezePost(
  id: number,
  userId: number,
): Promise<unknown> {
  const db = getDb();
  await db
    .update(positions)
    .set({ status: "FROZEN", closeReason: "manual_freeze", lastStateChangeTs: Date.now(), updatedAt: new Date() })
    .where(eq(positions.id, id));
  await writeAudit({
    actor: "mini_app",
    userId,
    action: "position_manual_freeze",
    target: String(id),
    payload: {},
  });
  return { ok: true, id };
}

async function handleWhaleProfile(addr: string): Promise<unknown> {
  const db = getDb();
  const w = await db.query.whales.findFirst({ where: eq(whales.address, addr.toLowerCase()) });
  if (!w) return { error: "not_found" };
  return {
    address: w.address,
    classification: w.classification,
    confidence: Number(w.confidence ?? 0),
    tracked: w.tracked,
    smScore: Number(w.smScore ?? 0),
    trustScore: Number(w.trustScore ?? 0),
    totalTrades: w.totalTrades,
    winRate: Number(w.winRate ?? 0),
    avgHoldHours: Number(w.avgHoldHours ?? 0),
    directionalRatio: Number(w.directionalRatio ?? 0),
    domainBreakdown: w.domainBreakdown,
    perDomainClassification: w.perDomainClassification,
    lastActivityAt: w.lastActivityAt,
  };
}

async function handleWhaleTrackPost(
  address: string,
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { tracked?: boolean };
  if (typeof body.tracked !== "boolean") {
    return { ok: false, error: "tracked must be boolean" };
  }
  const db = getDb();
  await db
    .update(whales)
    .set({ tracked: body.tracked })
    .where(eq(whales.address, address.toLowerCase()));
  await writeAudit({
    actor: "mini_app",
    userId,
    action: body.tracked ? "whale_track" : "whale_untrack",
    target: address,
    payload: {},
  });
  return { ok: true, address, tracked: body.tracked };
}

async function handleNotificationsList(userId: number): Promise<unknown> {
  return await listNotificationSettings(userId);
}

async function handleNotificationsPost(
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { event?: string; enabled?: boolean };
  if (!body.event || typeof body.enabled !== "boolean") {
    return { ok: false, error: "event + enabled required" };
  }
  if (!NOTIFICATION_EVENTS.includes(body.event as NotificationEvent)) {
    return { ok: false, error: `unknown event; allowed: ${NOTIFICATION_EVENTS.join(", ")}` };
  }
  await setNotificationEnabled({
    userId,
    event: body.event as NotificationEvent,
    enabled: body.enabled,
  });
  await writeAudit({
    actor: "mini_app",
    userId,
    action: "notification_setting",
    target: body.event,
    payload: { enabled: body.enabled },
  });
  return { ok: true, event: body.event, enabled: body.enabled };
}

async function handleKillSwitchPost(
  req: http.IncomingMessage,
  userId: number,
): Promise<unknown> {
  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { active?: boolean; reason?: string };
  await setRuntimeKillSwitch({
    active: Boolean(body.active),
    reason: body.reason ?? "mini_app",
  });
  await writeAudit({
    actor: "mini_app",
    userId,
    action: body.active ? "kill_switch_on" : "kill_switch_off",
    target: "global",
    payload: { reason: body.reason ?? null },
  });
  return { ok: true, active: Boolean(body.active) };
}

export function createRestServer(): http.Server {
  return http.createServer(async (req, res) => {
    const log = logger.child({ component: "rest_server", url: req.url, method: req.method });

    // Static /app/* (Mini App) — no auth gate; the auth is on the API layer.
    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res)) return;

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
        if (req.url === "/api/balance") return send(res, 200, await handleBalance());
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
        if (req.url === "/api/strategies") return send(res, 200, await handleStrategiesList());
        const strategyMatch = req.url?.match(/^\/api\/strategies\/(\d+)$/);
        if (strategyMatch && strategyMatch[1]) {
          const result = await handleStrategyById(Number(strategyMatch[1]));
          return send(res, result === null ? 404 : 200, result ?? { error: "not_found" });
        }
        if (req.url === "/api/exit_config") return send(res, 200, await handleExitConfig());
        if (req.url?.startsWith("/api/history")) return send(res, 200, await handleHistory(req));
        if (req.url === "/api/filters/registry") return send(res, 200, await handleFilterRegistry());
        if (req.url?.startsWith("/api/filters/stats")) return send(res, 200, await handleFilterStats(req));
        const whaleProfileMatch = req.url?.match(/^\/api\/whales\/(0x[0-9a-fA-F]{40})\/profile$/);
        if (whaleProfileMatch && whaleProfileMatch[1]) {
          const result = await handleWhaleProfile(whaleProfileMatch[1]);
          return send(res, (result as { error?: unknown }).error ? 404 : 200, result);
        }
        if (req.url === "/api/whales") return send(res, 200, await handleWhalesList());
        if (req.url === "/api/connections") return send(res, 200, await handleConnections());
        if (req.url === "/api/perf") return send(res, 200, await handlePerf());
        if (req.url?.startsWith("/api/audit")) return send(res, 200, await handleAudit(req));
        if (req.url?.startsWith("/api/kpi")) return send(res, 200, await handleKpi(req));
        if (req.url === "/api/build") return send(res, 200, await handleBuild());
        if (req.url?.startsWith("/api/latency"))
          return send(res, 200, await handleLatency(req));
        if (req.url === "/api/notifications")
          return send(res, 200, await handleNotificationsList(auth.userId ?? 1));
      }
      if (req.method === "POST") {
        if (req.url === "/api/notifications") {
          return send(res, 200, await handleNotificationsPost(req, auth.userId ?? 1));
        }
        if (req.url === "/api/kill_switch") return send(res, 200, await handleKillSwitchPost(req, auth.userId ?? 0));
        if (req.url === "/api/exit_config") {
          return send(res, 200, await handleExitConfigPost(req, auth.userId ?? 0));
        }
        const sParamsMatch = req.url?.match(/^\/api\/strategies\/(\d+)\/params$/);
        if (sParamsMatch && sParamsMatch[1]) {
          return send(res, 200, await handleStrategyParamsPost(Number(sParamsMatch[1]), req, auth.userId ?? 0));
        }
        const sEnabledMatch = req.url?.match(/^\/api\/strategies\/(\d+)\/enabled$/);
        if (sEnabledMatch && sEnabledMatch[1]) {
          return send(res, 200, await handleStrategyEnabledPost(Number(sEnabledMatch[1]), req, auth.userId ?? 0));
        }
        const exitMatch = req.url?.match(/^\/api\/positions\/(\d+)\/exit$/);
        if (exitMatch && exitMatch[1]) {
          return send(res, 200, await handlePositionExitPost(Number(exitMatch[1]), req, auth.userId ?? 0));
        }
        const freezeMatch = req.url?.match(/^\/api\/positions\/(\d+)\/freeze$/);
        if (freezeMatch && freezeMatch[1]) {
          return send(res, 200, await handlePositionFreezePost(Number(freezeMatch[1]), auth.userId ?? 0));
        }
        const whaleMatch = req.url?.match(/^\/api\/whales\/(0x[0-9a-fA-F]{40})\/track$/);
        if (whaleMatch && whaleMatch[1]) {
          return send(res, 200, await handleWhaleTrackPost(whaleMatch[1], req, auth.userId ?? 0));
        }
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
