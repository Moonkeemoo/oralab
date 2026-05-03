import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
  calibratorRecommendations,
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
import {
  downsample,
  getMarketsCachedBatch,
  outcomeNameForSide,
  renderExitReason,
  resolvesText,
} from "./market_enrich.js";

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
  if (rows.length === 0) return [];

  // Live mark + bid + ask + intent come from the most recent decision per
  // position (PositionMonitor writes at 2 Hz). Source-of-truth for the UI
  // "current price" + "live PnL" without re-fetching the order book.
  const ids = rows.map((p) => Number(p.id));
  type LiveRow = {
    position_id: number;
    mark: string | null;
    bid: string | null;
    ask: string | null;
    mark_source: string | null;
    mark_ts: string | null;
    intent_action: string | null;
    intent_reason: string | null;
    chain_shares: string | null;
    drift_pct: string | null;
  };
  // postgres-js returns array directly. Use IN(...) with comma list to
  // sidestep ANY($1) array-binding quirks across postgres-js versions.
  const idList = sql.raw(ids.join(","));
  const latest = (await db.execute(sql`
    SELECT DISTINCT ON (position_id)
      position_id,
      input_snapshot->>'mark'                                AS mark,
      input_snapshot->>'bid'                                 AS bid,
      input_snapshot->>'ask'                                 AS ask,
      input_snapshot->>'markSource'                          AS mark_source,
      input_snapshot->>'markTs'                              AS mark_ts,
      output_intent->>'action'                               AS intent_action,
      output_intent->>'reason'                               AS intent_reason,
      input_snapshot->'position'->>'onChainShares'           AS chain_shares,
      input_snapshot->'position'->>'reconciliationDriftPct'  AS drift_pct
    FROM decisions
    WHERE position_id IN (${idList})
    ORDER BY position_id, ts DESC
  `)) as unknown as LiveRow[];
  const liveByPos = new Map<number, LiveRow>();
  for (const row of latest) liveByPos.set(Number(row.position_id), row);

  // Sparkline: pull last ~50 mark values per position (downsample to 30 client-side
  // friendly points). One query covers all positions at once via window function.
  type SparkRow = { position_id: number; mark: string | null; ts: string };
  const sparkRaw = (await db.execute(sql`
    SELECT position_id, input_snapshot->>'mark' AS mark, ts
    FROM (
      SELECT position_id, input_snapshot, ts,
             ROW_NUMBER() OVER (PARTITION BY position_id ORDER BY ts DESC) AS rn
      FROM decisions
      WHERE position_id IN (${idList})
    ) sub
    WHERE rn <= 50
    ORDER BY position_id, ts ASC
  `)) as unknown as SparkRow[];
  const sparkByPos = new Map<number, number[]>();
  for (const r of sparkRaw) {
    if (r.mark == null) continue;
    const v = Number(r.mark);
    if (!Number.isFinite(v)) continue;
    const pid = Number(r.position_id);
    let arr = sparkByPos.get(pid);
    if (!arr) {
      arr = [];
      sparkByPos.set(pid, arr);
    }
    arr.push(v);
  }

  // Gamma metadata (market title + outcome names) for every asset in the page.
  // Cached per-asset for 60s — 50-row pages cost at most 50 cold-cache fetches.
  const markets = await getMarketsCachedBatch(rows.map((p) => p.assetId));

  const now = Date.now();
  return rows.map((p) => {
    const fillPrice = Number(p.fillPrice ?? 0);
    const shares = Number(p.shares ?? 0);
    const live = liveByPos.get(Number(p.id));
    const mark = live?.mark != null ? Number(live.mark) : null;
    const pnlUsd = mark != null && fillPrice > 0 ? (mark - fillPrice) * shares : null;
    const pnlPct = mark != null && fillPrice > 0 ? (mark - fillPrice) / fillPrice : null;
    // INV-D3: on-chain shares are surfaced from the latest decision's
    // input_snapshot. In DRY mode reconciler is skipped → chainShares==shares
    // always (DryFillSimulator IS the source of truth). In LIVE: drift > 0
    // means DB and chain disagree, > 0.05 reconciler tries sync, > 0.10 freeze.
    const chainShares = live?.chain_shares != null ? Number(live.chain_shares) : null;
    const driftPct = live?.drift_pct != null ? Number(live.drift_pct) : null;
    const market = markets.get(p.assetId) ?? null;
    const sparkVals = sparkByPos.get(Number(p.id)) ?? [];
    const fillTsMs = Number(p.fillTs ?? 0);
    return {
      id: p.id,
      status: p.status,
      conditionId: p.conditionId,
      assetId: p.assetId,
      side: p.side,
      shares,
      fillPrice,
      peakPrice: Number(p.peakPrice ?? 0),
      sweepCount: p.sweepCount,
      fillTs: Number(p.fillTs ?? 0),
      entryCostUsd: Number(p.entryCostUsd ?? 0),
      mode: p.mode,
      // Live (from latest decide_exit snapshot)
      currentPrice: mark,
      currentBid: live?.bid != null ? Number(live.bid) : null,
      currentAsk: live?.ask != null ? Number(live.ask) : null,
      markSource: live?.mark_source ?? null,
      markAgeMs:
        live?.mark_ts != null ? Math.max(0, Date.now() - Number(live.mark_ts)) : null,
      currentPnlUsd: pnlUsd,
      currentPnlPct: pnlPct,
      lastIntentAction: live?.intent_action ?? null,
      lastIntentReason: live?.intent_reason ?? null,
      // INV-D3 on-chain truth — match between DB and chain
      chainShares,
      driftPct,
      driftStatus:
        driftPct == null
          ? null
          : driftPct < 0.005
            ? "ok"
            : driftPct < 0.05
              ? "minor"
              : driftPct < 0.1
                ? "warn"
                : "freeze",
      // v1 parity enrichment
      marketTitle: market?.question ?? null,
      outcomeName: outcomeNameForSide(market, p.side),
      resolvesText: resolvesText(market, now),
      isSportsMarket: market?.isSportsMarket ?? false,
      durationMs: fillTsMs > 0 ? Math.max(0, now - fillTsMs) : null,
      priceChartPoints: downsample(sparkVals, 30),
    };
  });
}

async function handlePnl(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const nowMs = Date.now();
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  const mode = currentMode();
  const db = getDb();

  // For TODAY/WEEK/ALL summaries we need the full closed corpus, not just the
  // window slice. Pull all CLOSED positions for current mode in one shot.
  const allClosed = await db.query.positions.findMany({
    where: and(eq(positions.mode, mode), eq(positions.status, "CLOSED")),
  });

  // Per-position PnL is sum(SELL fills) − entryCostUsd. Aggregate fills in one
  // query keyed by position_id (avoids N+1).
  const pnlByPos = new Map<number, number>();
  if (allClosed.length > 0) {
    const sellRows = await db.query.fills.findMany({
      where: and(
        inArray(fills.positionId, allClosed.map((p) => Number(p.id))),
        eq(fills.side, "SELL"),
      ),
    });
    const sellSumByPos = new Map<number, number>();
    for (const f of sellRows) {
      const pid = Number(f.positionId ?? 0);
      const v = Number(f.shares ?? 0) * Number(f.price ?? 0);
      sellSumByPos.set(pid, (sellSumByPos.get(pid) ?? 0) + v);
    }
    for (const p of allClosed) {
      const id = Number(p.id);
      const exit = sellSumByPos.get(id) ?? 0;
      const entry = Number(p.entryCostUsd ?? 0);
      pnlByPos.set(id, exit - entry);
    }
  }

  // Today / week boundaries — UTC day for "today" is good enough for the
  // header pill (no per-user timezone wiring yet).
  const todayStart = new Date(nowMs);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const weekMs = nowMs - 7 * 24 * 60 * 60 * 1000;

  let today = 0;
  let week = 0;
  let all = 0;
  for (const p of allClosed) {
    const pnl = pnlByPos.get(Number(p.id)) ?? 0;
    const closeTs = Number(p.lastStateChangeTs ?? 0);
    all += pnl;
    if (closeTs >= weekMs) week += pnl;
    if (closeTs >= todayMs) today += pnl;
  }

  // Window-scoped breakdown + cumulative timeseries for sparkline. Sparkline
  // uses the windowed slice so the chart matches the active toggle.
  const windowed = allClosed
    .filter((p) => Number(p.lastStateChangeTs ?? 0) >= sinceMs)
    .slice()
    .sort((a, b) => Number(a.lastStateChangeTs) - Number(b.lastStateChangeTs));
  let totalEntry = 0;
  let totalExit = 0;
  let cum = 0;
  const breakdown: { id: number; closeReason: string | null; pnlUsd: number; pnlPct: number }[] = [];
  const timeseries: { ts: number; cumulativeUsd: number }[] = [];
  for (const p of windowed) {
    const id = Number(p.id);
    const pnl = pnlByPos.get(id) ?? 0;
    const entry = Number(p.entryCostUsd ?? 0);
    totalEntry += entry;
    totalExit += entry + pnl;
    cum += pnl;
    breakdown.push({
      id,
      closeReason: p.closeReason,
      pnlUsd: pnl,
      pnlPct: entry > 0 ? pnl / entry : 0,
    });
    timeseries.push({ ts: Number(p.lastStateChangeTs ?? 0), cumulativeUsd: cum });
  }

  return {
    windowHours,
    closedCount: windowed.length,
    totalEntryUsd: totalEntry,
    totalExitUsd: totalExit,
    netPnlUsd: totalExit - totalEntry,
    netPnlPct: totalEntry > 0 ? (totalExit - totalEntry) / totalEntry : 0,
    today,
    week,
    all,
    timeseries,
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
        mark: snap["mark"] != null ? Number(snap["mark"]) : null,
        bid: snap["bid"] != null ? Number(snap["bid"]) : null,
        ask: snap["ask"] != null ? Number(snap["ask"]) : null,
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
  // Gamma metadata for closed-position list — same caching strategy as live.
  const markets = await getMarketsCachedBatch(rows.map((p) => p.assetId));
  const nowMs = Date.now();

  const enriched = await Promise.all(
    rows.map(async (p) => {
      const sells = await db.query.fills.findMany({
        where: and(eq(fills.positionId, Number(p.id)), eq(fills.side, "SELL")),
      });
      const exitUsd = sells.reduce((s, f) => s + Number(f.shares ?? 0) * Number(f.price ?? 0), 0);
      // Effective exit price for display: weighted avg of SELL fills, falling back
      // to peakPrice when no fills exist (DRY simulator may close without a fill row).
      const sellShares = sells.reduce((s, f) => s + Number(f.shares ?? 0), 0);
      const exitPrice =
        sellShares > 0 ? exitUsd / sellShares : Number(p.peakPrice ?? 0) || null;
      const entryUsd = Number(p.entryCostUsd ?? 0);
      const pnl = exitUsd - entryUsd;
      const market = markets.get(p.assetId) ?? null;
      const reason = renderExitReason(p.closeReason);
      const fillTs = Number(p.fillTs ?? 0);
      const closeTs = Number(p.lastStateChangeTs ?? 0);
      return {
        id: p.id,
        assetId: p.assetId,
        side: p.side,
        shares: Number(p.shares ?? 0),
        fillPrice: Number(p.fillPrice ?? 0),
        peakPrice: Number(p.peakPrice ?? 0),
        exitPrice,
        closeReason: p.closeReason,
        closeReasonLabel: reason.label,
        closeReasonIcon: reason.icon,
        closeReasonFamily: reason.family,
        closeTs,
        fillTs,
        durationMs: fillTs > 0 && closeTs > 0 ? Math.max(0, closeTs - fillTs) : null,
        entryUsd,
        exitUsd,
        pnlUsd: pnl,
        pnlPct: entryUsd > 0 ? pnl / entryUsd : 0,
        outcome: pnl >= 0 ? "win" : "loss",
        result: pnl > 0 ? "won" : pnl < 0 ? "lost" : "break_even",
        marketTitle: market?.question ?? null,
        outcomeName: outcomeNameForSide(market, p.side),
        resolvesText: resolvesText(market, nowMs),
        isSportsMarket: market?.isSportsMarket ?? false,
        mode: p.mode,
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
  const mode = currentMode();
  const db = getDb();
  const sigRows = await db.query.signals.findMany({
    where: gte(signals.processedAt, new Date(sinceMs)),
    columns: { accepted: true, rejectReason: true },
  });
  const signalsTotal = sigRows.length;
  const signalsAccepted = sigRows.filter((r) => r.accepted).length;
  const signalsRejected = signalsTotal - signalsAccepted;
  const byReason: Record<string, number> = {};
  for (const r of sigRows) {
    if (!r.accepted && r.rejectReason) {
      byReason[r.rejectReason] = (byReason[r.rejectReason] ?? 0) + 1;
    }
  }
  let topRejection: string | null = null;
  let topRejectionCount = 0;
  for (const [k, v] of Object.entries(byReason)) {
    if (v > topRejectionCount) {
      topRejectionCount = v;
      topRejection = k;
    }
  }

  const closed = await db.query.positions.findMany({
    where: and(
      eq(positions.mode, mode),
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
  let tpHits = 0;
  let slHits = 0;
  let peakUnrealizedSum = 0;
  let realizedForPeakSum = 0;
  const equity: { ts: number; cum: number }[] = [];
  let cum = 0;
  const lossPnls: number[] = [];
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
      lossPnls.push(pnl);
    }
    holdSec += (Number(p.lastStateChangeTs) - Number(p.fillTs)) / 1000;
    cum += pnl;
    equity.push({ ts: Number(p.lastStateChangeTs), cum });

    // Exit-family classification — drives TP/SL hit rates and exit efficiency.
    const reason = renderExitReason(p.closeReason);
    if (reason.family === "tp") tpHits += 1;
    if (reason.family === "sl_standard" || reason.family === "sl_emergency") slHits += 1;

    // Theoretical peak unrealised PnL for this trade — based on peak_price tracker
    // captured live by the position monitor. (peak - fill) * shares.
    const fillPrice = Number(p.fillPrice ?? 0);
    const peakPrice = Number(p.peakPrice ?? 0);
    const shares = Number(p.shares ?? 0);
    const peakUnrealised = (peakPrice - fillPrice) * shares;
    if (peakUnrealised > 0) {
      peakUnrealizedSum += peakUnrealised;
      realizedForPeakSum += pnl;
    }
  }
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of equity) {
    if (e.cum > peak) peak = e.cum;
    const dd = peak - e.cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Exposure: how much of total budget is locked up in OPEN positions right now.
  const active = await db.query.positions.findMany({
    where: and(
      eq(positions.mode, mode),
      inArray(positions.status, [...ACTIVE_STATUSES]),
    ),
    columns: { entryCostUsd: true },
  });
  const exposureUsd = active.reduce((s, p) => s + Number(p.entryCostUsd ?? 0), 0);
  const openPositionCount = active.length;

  let totalBudgetUsd = 0;
  if (mode === "DRY") {
    const strats = await db.query.strategies.findMany({ columns: { params: true, enabled: true } });
    totalBudgetUsd = strats
      .filter((s) => s.enabled)
      .reduce(
        (s, st) => s + Number(((st.params as Record<string, unknown>) ?? {})["budgetUsd"] ?? 0),
        0,
      );
  }
  const exposurePct = totalBudgetUsd > 0 ? exposureUsd / totalBudgetUsd : 0;

  // Counter-factual saved-by-rejection — DRY-mode estimate. We can't replay
  // every rejected signal, so approximate as: (#rejects) * avg loss per losing
  // trade * (1/10 of an aggressive accept-everything baseline).  Plausibility >
  // accuracy here; v1 used a similar back-of-the-envelope number. Returns 0
  // when there are no losing trades to anchor against.
  const avgLoss = lossPnls.length > 0
    ? lossPnls.reduce((s, v) => s + v, 0) / lossPnls.length
    : 0;
  const cfSaved = Math.max(0, signalsRejected * Math.abs(avgLoss) * 0.1);
  const cfNet = (totalExit - totalEntry) + cfSaved;

  const closedCount = closed.length;
  const exitEfficiency = peakUnrealizedSum > 0 ? realizedForPeakSum / peakUnrealizedSum : 0;
  const leftOnTable = peakUnrealizedSum - realizedForPeakSum;

  return {
    windowHours,
    // Original v1-equivalent fields retained
    passRatePct: signalsTotal > 0 ? (signalsAccepted / signalsTotal) * 100 : 0,
    signalsPerHour: signalsTotal / windowHours,
    profitFactor: negPnl > 0 ? posPnl / negPnl : posPnl > 0 ? Infinity : 0,
    winRatePct: closedCount > 0 ? (wins / closedCount) * 100 : 0,
    avgHoldSec: closedCount > 0 ? holdSec / closedCount : 0,
    drawdownUsd: maxDrawdown,
    netPnlUsd: totalExit - totalEntry,
    closedCount,
    // ── v1-parity additions ──
    signalsTotal,
    signalsAccepted,
    signalsRejected,
    topRejection,
    topRejectionCount,
    tpHitRatePct: closedCount > 0 ? (tpHits / closedCount) * 100 : 0,
    slRatePct: closedCount > 0 ? (slHits / closedCount) * 100 : 0,
    exitEfficiencyPct: exitEfficiency * 100,
    leftOnTableUsd: leftOnTable,
    cfNetUsd: cfNet,
    cfSavedUsd: cfSaved,
    avgPnlPerTradeUsd: closedCount > 0 ? (totalExit - totalEntry) / closedCount : 0,
    avgDurationSec: closedCount > 0 ? holdSec / closedCount : 0,
    grossWinUsd: posPnl,
    grossLossUsd: negPnl,
    winsCount: wins,
    lossesCount: closedCount - wins,
    exposureUsd,
    exposurePct,
    openPositionCount,
    totalBudgetUsd,
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

  // FROZEN positions = phantoms (chain disagreement / manual freeze) — should
  // be 0 in DRY since the simulator IS source of truth. UI surfaces a count
  // pill so operators can spot freezes without scanning logs.
  const phantoms = await db.query.positions.findMany({
    where: and(eq(positions.mode, mode), eq(positions.status, "FROZEN")),
    columns: { id: true },
  });
  const phantomCount = phantoms.length;

  // Untracked = positions whose strategyId is no longer enabled. Cheap proxy
  // for "we hold this but the strategy that opened it is off".
  const untrackedRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM positions p
    LEFT JOIN strategies s ON s.id = p.strategy_id
    WHERE p.mode = ${mode}
      AND p.status IN ('PENDING','FILLED','OPEN','EXITING','RESOLVED','FROZEN')
      AND (s.id IS NULL OR s.enabled = false)
  `)) as unknown as { n: number }[];
  const untrackedCount = untrackedRows[0]?.n ?? 0;

  // Polymarket pUSD deposit page — placeholder until we wire up a real link
  // (eg whitelabel deposit flow). Mini App "Top Up" button just opens this URL.
  const topUpUrl = "https://polymarket.com/account/deposit";

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
      phantomCount,
      untrackedCount,
      topUpUrl,
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
      phantomCount,
      untrackedCount,
      topUpUrl,
      source: "clob_balance_allowance",
    };
  } catch (err) {
    return {
      mode: "LIVE",
      error: `clob balance fetch failed: ${(err as Error).message}`,
      allocatedUsd,
      phantomCount,
      untrackedCount,
      topUpUrl,
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

// ─── Calibrator (P2c) ───────────────────────────────────────────────────────

async function handleCalibratorStatus(): Promise<unknown> {
  const db = getDb();
  // Latest cycle = latest createdAt across all rec rows. We surface its id,
  // timestamp, and rec count + when the next daemon run would fire.
  const latest = await db.query.calibratorRecommendations.findMany({
    orderBy: (c, { desc }) => [desc(c.createdAt)],
    limit: 1,
  });
  const intervalMs = Number(process.env["CAL_INTERVAL_MS"] ?? 3_600_000);
  const head = latest[0];
  if (!head) {
    return {
      mode: "idle",
      lastRunAt: null,
      lastCycleId: null,
      lastRecCount: 0,
      intervalMs,
      nextRunAt: null,
    };
  }
  // Count rows in that cycle (all recs share createdAt within ~1ms of each other,
  // but cycle_id is the canonical group key).
  const sameCycle = await db.query.calibratorRecommendations.findMany({
    where: eq(calibratorRecommendations.cycleId, head.cycleId),
    columns: { id: true },
  });
  return {
    mode: "scheduled",
    lastRunAt: head.createdAt.toISOString(),
    lastCycleId: head.cycleId,
    lastRecCount: sameCycle.length,
    intervalMs,
    nextRunAt: new Date(head.createdAt.getTime() + intervalMs).toISOString(),
  };
}

async function handleCalibratorRecommendations(): Promise<unknown> {
  const db = getDb();
  // Pull the most recent cycle, then return its rows sorted by lift desc.
  const latest = await db.query.calibratorRecommendations.findMany({
    orderBy: (c, { desc }) => [desc(c.createdAt)],
    limit: 1,
  });
  if (!latest[0]) return { cycleId: null, recommendations: [] };
  const cycleId = latest[0].cycleId;
  const rows = await db.query.calibratorRecommendations.findMany({
    where: eq(calibratorRecommendations.cycleId, cycleId),
    orderBy: (c, { desc }) => [desc(c.liftEstimateUsd)],
    limit: 20,
  });
  return {
    cycleId,
    runAt: latest[0].createdAt.toISOString(),
    recommendations: rows.map((r) => ({
      id: r.id,
      filterName: r.filterName,
      paramKey: r.paramKey,
      currentValue: r.currentValue,
      recommendedValue: r.recommendedValue,
      direction: r.direction,
      liftEstimateUsd: r.liftEstimateUsd,
      liftKpi: r.liftKpi,
      confidence: r.confidence,
      sampleSize: r.sampleSize,
      reason: r.reason,
    })),
  };
}

async function handleCalibratorRunPost(userId: number): Promise<unknown> {
  // Dynamic import — keeps the calibrator module out of the API process's
  // hot path until someone actually triggers a manual run.
  const { runCycle } = await import("../calibrator/engine.js");
  const r = await runCycle();
  await writeAudit({
    actor: "mini_app",
    userId,
    action: "calibrator_manual_run",
    target: r.cycleId,
    payload: { recCount: r.recommendations.length, acceptedCount: r.acceptedCount },
  });
  return {
    cycleId: r.cycleId,
    recCount: r.recommendations.length,
    acceptedCount: r.acceptedCount,
    avgPnlPerTradeUsd: r.avgPnlPerTradeUsd,
    summary: r.recommendations.slice(0, 5).map((rec) => ({
      filterName: rec.filterName,
      direction: rec.direction,
      liftEstimateUsd: rec.liftEstimateUsd,
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
        if (req.url === "/api/calibrator/status")
          return send(res, 200, await handleCalibratorStatus());
        if (req.url === "/api/calibrator/recommendations")
          return send(res, 200, await handleCalibratorRecommendations());
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
        if (req.url === "/api/calibrator/run") {
          return send(res, 200, await handleCalibratorRunPost(auth.userId ?? 0));
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
