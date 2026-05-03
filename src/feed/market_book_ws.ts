import process from "node:process";
import { WebSocket } from "ws";
import { logger } from "../obs/logger.js";

/**
 * MarketBookWs — subscribes to Polymarket CLOB market channel for live
 * book updates on assets we hold positions on.
 *
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * Subscribe payload (no auth needed for market channel):
 *   { type: "market", assets_ids: [<assetId>...] }
 *
 * Server pushes events of two shapes (per Polymarket V2 docs + observation):
 *   - "book"            full snapshot: bids[], asks[], asset_id, timestamp
 *   - "price_change"    delta:        size, side, price, asset_id, timestamp
 *   - "last_trade_price"               last trade only — informational
 *
 * We persist the latest top-of-book per asset in a module-level Map. Stale
 * entries (older than WS_BOOK_MAX_AGE_MS, default 5s) are treated as
 * unavailable so callers fall back to REST. Subscriptions auto-resync on
 * reconnect by re-listing the assets PositionMonitor currently tracks via
 * the registerAssets() interface.
 */

interface BookTop {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  ts: number;
}

const _book = new Map<string, BookTop>();
const _subscribed = new Set<string>();
const WS_URL =
  process.env["CLOB_WS_MARKET_URL"] ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const MAX_AGE_MS = Number(process.env["WS_BOOK_MAX_AGE_MS"] ?? 5_000);
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

let ws: WebSocket | null = null;
let backoff = RECONNECT_MIN_MS;
let stopped = false;
let healthInterval: NodeJS.Timeout | null = null;

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

interface RawPriceChangeEvent {
  event_type: "price_change";
  asset_id: string;
  changes?: { price: string; side: "BUY" | "SELL"; size: string }[];
  timestamp?: string | number;
}

type RawEvent = RawBookEvent | RawPriceChangeEvent;

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

function applyBookSnapshot(ev: RawBookEvent): void {
  const bid = topOfSide(ev.bids, true);
  const ask = topOfSide(ev.asks, false);
  if (bid.p <= 0 || ask.p <= 0) return; // empty book — ignore
  const ts =
    typeof ev.timestamp === "string"
      ? Number(ev.timestamp) || Date.now()
      : typeof ev.timestamp === "number"
        ? ev.timestamp
        : Date.now();
  _book.set(ev.asset_id, { bid: bid.p, ask: ask.p, bidSize: bid.s, askSize: ask.s, ts });
}

function applyPriceChange(ev: RawPriceChangeEvent): void {
  const cur = _book.get(ev.asset_id);
  if (!cur || !ev.changes) return; // ignore until full snapshot lands
  let { bid, ask, bidSize, askSize } = cur;
  for (const c of ev.changes) {
    const price = Number(c.price);
    const size = Number(c.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (c.side === "BUY" && price > bid) {
      bid = price;
      bidSize = size;
    } else if (c.side === "SELL" && (price < ask || ask === 0)) {
      ask = price;
      askSize = size;
    } else if (c.side === "BUY" && price === bid) {
      bidSize = size;
    } else if (c.side === "SELL" && price === ask) {
      askSize = size;
    }
  }
  const ts =
    typeof ev.timestamp === "string"
      ? Number(ev.timestamp) || Date.now()
      : typeof ev.timestamp === "number"
        ? ev.timestamp
        : Date.now();
  _book.set(ev.asset_id, { bid, ask, bidSize, askSize, ts });
}

function handleMessage(data: Buffer): void {
  let parsed: RawEvent | RawEvent[];
  try {
    parsed = JSON.parse(data.toString()) as RawEvent | RawEvent[];
  } catch {
    return; // non-JSON ping etc.
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  for (const ev of events) {
    if (!("asset_id" in ev) || !ev.asset_id) continue;
    if (ev.event_type === "price_change") applyPriceChange(ev);
    else if (ev.event_type === "book" || (!ev.event_type && "bids" in ev))
      applyBookSnapshot(ev as RawBookEvent);
  }
}

function sendSubscribe(socket: WebSocket): void {
  if (_subscribed.size === 0) return;
  const payload = JSON.stringify({ type: "market", assets_ids: Array.from(_subscribed) });
  try {
    socket.send(payload);
    logger.debug({ count: _subscribed.size }, "market WS subscribed");
  } catch (err) {
    logger.warn({ err }, "market WS subscribe send failed");
  }
}

function connect(): void {
  if (stopped) return;
  const log = logger.child({ component: "market_book_ws", url: WS_URL });
  const socket = new WebSocket(WS_URL);
  ws = socket;
  socket.on("open", () => {
    log.info({ subscriptions: _subscribed.size }, "market WS connected");
    backoff = RECONNECT_MIN_MS;
    sendSubscribe(socket);
  });
  socket.on("message", (data: Buffer) => handleMessage(data));
  socket.on("close", (code, reason) => {
    log.warn({ code, reason: reason.toString() }, "market WS closed; will reconnect");
    scheduleReconnect();
  });
  socket.on("error", (err) => log.error({ err }, "market WS error"));
}

function scheduleReconnect(): void {
  if (stopped) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
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

/**
 * Idempotent registration of an asset to subscribe to. Triggers a
 * subscribe message immediately if WS is open; otherwise the asset will
 * be included on next connect/reconnect.
 */
export function registerAsset(assetId: string): void {
  if (_subscribed.has(assetId)) return;
  _subscribed.add(assetId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "market", assets_ids: [assetId] }));
    } catch (err) {
      logger.warn({ err, assetId }, "market WS register send failed");
    }
  }
}

/**
 * Drop subscriptions that are no longer tracked. Reduces noise on long-
 * running processes. Note: Polymarket market channel has no explicit
 * unsubscribe — we let stale entries age out and rely on fresh subscribe
 * payloads after reconnect.
 */
export function pruneAssets(activeAssetIds: ReadonlySet<string>): void {
  for (const id of _subscribed) {
    if (!activeAssetIds.has(id)) _subscribed.delete(id);
  }
  for (const id of _book.keys()) {
    if (!activeAssetIds.has(id)) _book.delete(id);
  }
}

export function startMarketBookWs(): void {
  if (ws !== null) return;
  stopped = false;
  connect();
  if (!healthInterval) {
    healthInterval = setInterval(() => {
      if (ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        scheduleReconnect();
      }
    }, 30_000);
    healthInterval.unref?.();
  }
}

export function stopMarketBookWs(): void {
  stopped = true;
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
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
