import process from "node:process";
import { WebSocket } from "ws";
import { logger } from "../obs/logger.js";

/**
 * MarketBookWs — Polymarket CLOB market channel client.
 *
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * Ported from v1 bots/ws_feed.py (production-tested) with two safety
 * patterns that turn out to matter on real Polymarket WS:
 *
 *   1. PING + dual heartbeat watchdog
 *      ─ HEARTBEAT_TRACKER counts ALL frames (including PONG): 30s threshold,
 *        catches a flat-out dead socket.
 *      ─ DATA_TRACKER counts only real book/price events: 45s threshold,
 *        catches the "zombie" state where socket is technically alive (PONG
 *        works) but Polymarket has stopped delivering book updates
 *        (GitHub polymarket/issues #292, #26).
 *      Either tracker tripping ⇒ force socket close ⇒ reconnect loop fires.
 *
 *   2. Subscribe payload requires `custom_feature_enabled: true`. Without it,
 *      Polymarket silently accepts the connection but never sends book
 *      snapshots — you only get sporadic price_change events (which is what
 *      v2 was seeing before this rewrite: 12 ws_book hits in 60s instead of
 *      hundreds).
 *
 * Subscribe shapes:
 *
 *   initial connect:
 *     { type: "market", assets_ids: [...], custom_feature_enabled: true }
 *
 *   mid-session add:
 *     { type: "market", assets_ids: [...], custom_feature_enabled: true,
 *       operation: "subscribe" }
 *
 *   mid-session drop:
 *     { operation: "unsubscribe", assets_ids: [...] }
 *
 * price_change shape (single price, not a `changes[]` array — my first pass
 * had this wrong):
 *   { event_type: "price_change", asset_id, price, side: "BUY"|"SELL",
 *     size, timestamp }
 *
 * Dead-book filter: bid <= 0.02 is Polymarket's zombie placeholder; ignore.
 */

interface BookTop {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  ts: number;
}

interface RawBookSide {
  price: string;
  size: string;
}

interface RawBookEvent {
  event_type?: "book";
  asset_id: string;
  market?: string;
  bids?: RawBookSide[];
  asks?: RawBookSide[];
  timestamp?: string | number;
}

/**
 * price_change real shape (v1 confirmed): wrapper carries `market` only;
 * each entry in `price_changes[]` has `asset_id`, the level price/size that
 * just changed, AND `best_bid` / `best_ask` reflecting the resulting top
 * of book. We use the latter two directly — no need to rebuild from delta.
 */
interface RawPriceChangeEntry {
  asset_id: string;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  best_bid?: string;
  best_ask?: string;
}
interface RawPriceChangeEvent {
  event_type: "price_change";
  market?: string;
  price_changes?: RawPriceChangeEntry[];
  timestamp?: string | number;
  // Some legacy single-event shapes still flat:
  asset_id?: string;
  price?: string;
  side?: "BUY" | "SELL";
  size?: string;
}

interface RawTickSizeEvent {
  event_type: "tick_size_change";
  asset_id: string;
  tick_size?: string;
  new_tick_size?: string;
  timestamp?: string | number;
}

type RawEvent = RawBookEvent | RawPriceChangeEvent | RawTickSizeEvent;

const _book = new Map<string, BookTop>();
const _subscribed = new Set<string>();
const _tickSizes = new Map<string, { tick: number; ts: number }>();

const WS_URL =
  process.env["CLOB_WS_MARKET_URL"] ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const MAX_AGE_MS = Number(process.env["WS_BOOK_MAX_AGE_MS"] ?? 5_000);
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// Heartbeat tracking — same thresholds as v1.
const PING_INTERVAL_MS = Number(process.env["WS_PING_INTERVAL_MS"] ?? 20_000);
const PING_JITTER_MAX_MS = Number(process.env["WS_PING_JITTER_MAX_MS"] ?? 5_000);
const HEARTBEAT_THRESHOLD_MS = Number(process.env["WS_HEARTBEAT_THRESHOLD_MS"] ?? 30_000);
const DATA_SILENCE_THRESHOLD_MS = Number(process.env["WS_DATA_SILENCE_THRESHOLD_MS"] ?? 45_000);
const DEAD_BOOK_BID_THRESHOLD = Number(process.env["WS_DEAD_BOOK_BID_THRESHOLD"] ?? 0.02);

let ws: WebSocket | null = null;
let backoffMs = RECONNECT_MIN_MS;
let stopped = false;
let pingTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
let lastFrameTs = 0; // any frame including PONG → catches dead socket
let lastDataTs = 0; // only real book/price_change → catches zombie

function topOfSide(arr: RawBookSide[] | undefined, sortDesc: boolean): { p: number; s: number } {
  if (!arr || arr.length === 0) return { p: 0, s: 0 };
  // Polymarket sometimes sends arrays unsorted; pick the best price ourselves.
  const sorted = [...arr].sort((a, b) =>
    sortDesc ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price),
  );
  const top = sorted[0];
  if (!top) return { p: 0, s: 0 };
  return { p: Number(top.price) || 0, s: Number(top.size) || 0 };
}

function parseTs(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Date.now();
}

function applyBookSnapshot(ev: RawBookEvent): boolean {
  const bid = topOfSide(ev.bids, true);
  const ask = topOfSide(ev.asks, false);
  if (bid.p <= 0 || ask.p <= 0) return false;
  // Dead-book guard: Polymarket zombie state often emits bid=0.01.
  if (bid.p <= DEAD_BOOK_BID_THRESHOLD) return false;
  _book.set(ev.asset_id, {
    bid: bid.p,
    ask: ask.p,
    bidSize: bid.s,
    askSize: ask.s,
    ts: parseTs(ev.timestamp),
  });
  return true;
}

function applyPriceChange(ev: RawPriceChangeEvent): boolean {
  const ts = parseTs(ev.timestamp);
  // Multi-asset shape: price_changes[] each carries its own asset_id +
  // resulting best_bid/best_ask. v1 source-of-truth path.
  if (Array.isArray(ev.price_changes) && ev.price_changes.length > 0) {
    let any = false;
    for (const entry of ev.price_changes) {
      if (!entry?.asset_id) continue;
      const bid = Number(entry.best_bid ?? 0);
      const ask = Number(entry.best_ask ?? 0);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
      if (bid <= 0 || ask <= 0) continue;
      if (bid <= DEAD_BOOK_BID_THRESHOLD) continue;
      const cur = _book.get(entry.asset_id);
      _book.set(entry.asset_id, {
        bid,
        ask,
        bidSize: cur?.bidSize ?? 0,
        askSize: cur?.askSize ?? 0,
        ts,
      });
      any = true;
    }
    return any;
  }
  // Legacy single-entry shape (kept as fallback)
  const cur = _book.get(ev.asset_id ?? "");
  if (!cur || ev.asset_id == null) return false;
  if (ev.price == null || ev.side == null) return false;
  const price = Number(ev.price);
  const size = Number(ev.size ?? 0);
  if (!Number.isFinite(price) || price <= 0) return false;
  let { bid, ask, bidSize, askSize } = cur;
  if (ev.side === "BUY") {
    if (price > bid || size === 0) {
      bid = price;
      bidSize = size;
    } else if (price === bid) {
      bidSize = size;
    }
  } else if (ev.side === "SELL") {
    if (price < ask || ask === 0 || size === 0) {
      ask = price;
      askSize = size;
    } else if (price === ask) {
      askSize = size;
    }
  }
  if (bid <= DEAD_BOOK_BID_THRESHOLD) return false;
  _book.set(ev.asset_id, { bid, ask, bidSize, askSize, ts });
  return true;
}

interface RawBestBidAskEvent {
  event_type: "best_bid_ask";
  market?: string;
  asset_id?: string;
  best_bid?: string;
  best_ask?: string;
  timestamp?: string | number;
}

function applyBestBidAsk(ev: RawBestBidAskEvent): boolean {
  const assetId = ev.asset_id ?? "";
  if (!assetId) return false;
  const bid = Number(ev.best_bid ?? 0);
  const ask = Number(ev.best_ask ?? 0);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false;
  if (bid <= 0 || ask <= 0) return false;
  if (bid <= DEAD_BOOK_BID_THRESHOLD) return false;
  const cur = _book.get(assetId);
  _book.set(assetId, {
    bid,
    ask,
    bidSize: cur?.bidSize ?? 0,
    askSize: cur?.askSize ?? 0,
    ts: parseTs(ev.timestamp),
  });
  return true;
}

function applyTickSize(ev: RawTickSizeEvent): void {
  const tickRaw = ev.new_tick_size ?? ev.tick_size;
  if (tickRaw == null) return;
  const tick = Number(tickRaw);
  if (!Number.isFinite(tick) || tick <= 0) return;
  _tickSizes.set(ev.asset_id, { tick, ts: parseTs(ev.timestamp) });
}

// Lightweight per-event-type counters surfaced via marketWsHealth()
const _evCounts = { book: 0, price_change: 0, tick_size_change: 0, other: 0, dropped: 0 };
const _dropReasons = new Map<string, number>();
function bumpDrop(reason: string): void {
  _dropReasons.set(reason, (_dropReasons.get(reason) ?? 0) + 1);
  _evCounts.dropped += 1;
}
let _firstFewSamples = 5;
let _firstFewDropSamples = 5;
function sampleEventShape(ev: unknown): void {
  if (_firstFewSamples <= 0) return;
  _firstFewSamples -= 1;
  try {
    const sample = JSON.stringify(ev).slice(0, 400);
    logger.info({ sample }, "market WS sample raw event");
  } catch {
    // ignore
  }
}
function sampleDropShape(ev: unknown, reason: string): void {
  if (_firstFewDropSamples <= 0) return;
  _firstFewDropSamples -= 1;
  try {
    const sample = JSON.stringify(ev).slice(0, 400);
    logger.info({ sample, reason }, "market WS sample DROPPED event");
  } catch {
    // ignore
  }
}

function handleFrame(data: Buffer): void {
  lastFrameTs = Date.now();
  const text = data.toString();
  if (text === "PONG" || text === "pong") return;
  let parsed: RawEvent | RawEvent[];
  try {
    parsed = JSON.parse(text) as RawEvent | RawEvent[];
  } catch {
    return;
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  let liveData = false;
  for (const ev of events) {
    sampleEventShape(ev);
    if (!ev || typeof ev !== "object") {
      bumpDrop("non_object");
      sampleDropShape(ev, "non_object");
      continue;
    }
    // Polymarket payloads sometimes carry the token id as `asset_id` and
    // sometimes as `market`; v1 has the same fallback. Normalize early.
    const evRecord = ev as unknown as Record<string, unknown>;
    const assetId =
      (evRecord["asset_id"] as string | undefined) ??
      (evRecord["market"] as string | undefined) ??
      "";
    if (!assetId) {
      bumpDrop("no_asset_id");
      sampleDropShape(ev, "no_asset_id");
      continue;
    }
    evRecord["asset_id"] = assetId;
    const et = ev.event_type;
    if (et === "book" || (!et && "bids" in ev)) {
      if (applyBookSnapshot(ev as RawBookEvent)) {
        liveData = true;
        _evCounts.book += 1;
      } else {
        bumpDrop("book_dead_or_empty");
      }
    } else if (et === "price_change") {
      if (applyPriceChange(ev as RawPriceChangeEvent)) {
        liveData = true;
        _evCounts.price_change += 1;
      } else {
        bumpDrop("price_change_invalid");
      }
    } else if (et === "best_bid_ask") {
      if (applyBestBidAsk(ev as RawBestBidAskEvent)) {
        liveData = true;
        _evCounts.price_change += 1;
      } else {
        bumpDrop("best_bid_ask_invalid");
      }
    } else if (et === "last_trade_price" || et === "new_market") {
      // Informational only; don't count as drop noise.
      _evCounts.other += 1;
    } else if (et === "tick_size_change") {
      applyTickSize(ev as RawTickSizeEvent);
      _evCounts.tick_size_change += 1;
    } else {
      _evCounts.other += 1;
      bumpDrop(`unknown_type:${String(et).slice(0, 30)}`);
    }
  }
  if (liveData) lastDataTs = Date.now();
}

function buildSubscribePayload(
  assetIds: readonly string[],
  initial: boolean,
): string {
  const payload: Record<string, unknown> = {
    type: "market",
    assets_ids: assetIds,
    custom_feature_enabled: true,
  };
  if (!initial) payload["operation"] = "subscribe";
  return JSON.stringify(payload);
}

function safeSend(socket: WebSocket, payload: string, what: string): void {
  try {
    socket.send(payload);
  } catch (err) {
    logger.warn({ err, what }, "market WS send failed");
  }
}

function sendInitialSubscribe(socket: WebSocket): void {
  if (_subscribed.size === 0) return;
  safeSend(
    socket,
    buildSubscribePayload(Array.from(_subscribed), true),
    "initial_subscribe",
  );
  logger.info({ count: _subscribed.size }, "market WS subscribed (initial batch)");
}

function startPingLoop(socket: WebSocket): void {
  if (pingTimer) clearTimeout(pingTimer);
  const tick = (): void => {
    if (stopped || ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      // Polymarket expects a PING frame, not a JSON payload.
      socket.ping();
    } catch (err) {
      logger.warn({ err }, "market WS ping failed");
    }
    // Watchdog 1: dead-socket (no frames at all)
    if (lastFrameTs > 0 && Date.now() - lastFrameTs > HEARTBEAT_THRESHOLD_MS) {
      logger.warn(
        { ageMs: Date.now() - lastFrameTs, threshold: HEARTBEAT_THRESHOLD_MS },
        "market WS silent freeze → forcing reconnect",
      );
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }
    // Watchdog 2: zombie (PONG works, no real events)
    if (
      lastDataTs > 0 &&
      Date.now() - lastDataTs > DATA_SILENCE_THRESHOLD_MS &&
      _subscribed.size > 0
    ) {
      logger.warn(
        { ageMs: Date.now() - lastDataTs, threshold: DATA_SILENCE_THRESHOLD_MS },
        "market WS zombie (no book events) → forcing reconnect",
      );
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }
    const delay = PING_INTERVAL_MS + Math.random() * PING_JITTER_MAX_MS;
    pingTimer = setTimeout(tick, delay);
    pingTimer.unref?.();
  };
  // First tick after one full interval, not immediately.
  pingTimer = setTimeout(tick, PING_INTERVAL_MS);
  pingTimer.unref?.();
}

function connect(): void {
  if (stopped) return;
  const log = logger.child({ component: "market_book_ws", url: WS_URL });
  const socket = new WebSocket(WS_URL);
  ws = socket;
  socket.on("open", () => {
    log.info({ subscriptions: _subscribed.size }, "market WS connected");
    backoffMs = RECONNECT_MIN_MS;
    lastFrameTs = Date.now();
    lastDataTs = Date.now();
    sendInitialSubscribe(socket);
    startPingLoop(socket);
  });
  socket.on("message", (data: Buffer) => handleFrame(data));
  socket.on("pong", () => {
    lastFrameTs = Date.now();
  });
  socket.on("close", (code, reason) => {
    log.warn({ code, reason: reason.toString() }, "market WS closed; will reconnect");
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    if (ws === socket) ws = null;
    scheduleReconnect();
  });
  socket.on("error", (err) => log.error({ err }, "market WS error"));
}

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  setTimeout(() => connect(), delay).unref?.();
}

/**
 * Returns the latest WS-derived book top for an asset, or null if missing
 * or staler than WS_BOOK_MAX_AGE_MS. Caller falls back to REST in that case.
 */
export function getWsBook(
  assetId: string,
): { bid: number; ask: number; bidSize: number; askSize: number; ts: number } | null {
  const top = _book.get(assetId);
  if (!top) return null;
  if (Date.now() - top.ts > MAX_AGE_MS) return null;
  return top;
}

/** Latest cached tick_size from a tick_size_change event, if any. */
export function getWsTickSize(assetId: string): number | null {
  const t = _tickSizes.get(assetId);
  return t ? t.tick : null;
}

/**
 * Idempotent registration of an asset to subscribe to. If WS open, sends
 * a mid-session subscribe message. Otherwise the asset will be included
 * on next connect.
 */
export function registerAsset(assetId: string): void {
  if (_subscribed.has(assetId)) return;
  _subscribed.add(assetId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    safeSend(ws, buildSubscribePayload([assetId], false), "register_asset");
    logger.info(
      { asset: assetId.slice(0, 16), totalSubscribed: _subscribed.size },
      "market WS mid-session subscribe sent",
    );
  } else {
    logger.debug({ asset: assetId.slice(0, 16) }, "market WS not open — queued for next connect");
  }
}

/**
 * Drop subscriptions that are no longer tracked. Sends explicit
 * unsubscribe messages so Polymarket stops streaming events for stale
 * assets — important on long-running processes that cycle through many
 * markets.
 */
export function pruneAssets(activeAssetIds: ReadonlySet<string>): void {
  const drop: string[] = [];
  for (const id of _subscribed) {
    if (!activeAssetIds.has(id)) drop.push(id);
  }
  for (const id of drop) {
    _subscribed.delete(id);
    _book.delete(id);
    _tickSizes.delete(id);
  }
  if (drop.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
    safeSend(
      ws,
      JSON.stringify({ operation: "unsubscribe", assets_ids: drop }),
      "unsubscribe",
    );
  }
}

/** Health snapshot for /api/connections — what UI shows. */
export function marketWsHealth(): {
  connected: boolean;
  subscribedCount: number;
  cachedBookCount: number;
  lastFrameAgeMs: number | null;
  lastDataAgeMs: number | null;
  events: typeof _evCounts;
  topDropReasons: Record<string, number>;
} {
  const topDrops = [..._dropReasons.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    subscribedCount: _subscribed.size,
    cachedBookCount: _book.size,
    lastFrameAgeMs: lastFrameTs > 0 ? Date.now() - lastFrameTs : null,
    lastDataAgeMs: lastDataTs > 0 ? Date.now() - lastDataTs : null,
    events: { ..._evCounts },
    topDropReasons: Object.fromEntries(topDrops),
  };
}

export function startMarketBookWs(): void {
  if (ws !== null) return;
  stopped = false;
  connect();
  if (!healthTimer) {
    healthTimer = setInterval(() => {
      // Self-heal if for some reason connect() never reached open
      if (!ws && !stopped) scheduleReconnect();
      // Periodic health log so we can see in the trader log whether
      // events are flowing and which types.
      logger.info(marketWsHealth(), "market WS health");
    }, 30_000);
    healthTimer.unref?.();
  }
}

export function stopMarketBookWs(): void {
  stopped = true;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (pingTimer) {
    clearTimeout(pingTimer);
    pingTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}
