# Polymarket Whale Signal Collection — Handoff

> **Goal**: how to ingest whale activity, market books, sports events, and own fills from Polymarket fast and reliably. Distilled from v2 production code at `Moonkeemoo/oralab` (`src/feed/*`, `src/api/*`, `src/execute/fill_reconciler.ts`). Every URL/header/payload/gotcha here is verified live in production.

---

## Endpoint inventory

### REST (read)

| Purpose | Base URL | Source |
|---|---|---|
| Order book top-of-book | `https://clob.polymarket.com/book/{token_id}` | `src/api/book.ts` |
| Midpoint, last-trade-price | `https://clob.polymarket.com/{midpoint,price,last-trade-price}/{token_id}` | same |
| Market metadata (gamma) | `https://gamma-api.polymarket.com/markets?clob_token_ids={id}` | `src/api/gamma.ts` |
| User positions (chain truth) | `https://data-api.polymarket.com/positions?user={wallet}` | `src/api/data.ts` |
| User activity / trades | `https://data-api.polymarket.com/activity?user={wallet}&limit=100` | same |

Auth: none for read.

### WebSocket (push)

| Channel | URL | Auth | Use |
|---|---|---|---|
| **Market book** | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | none | top-of-book + price changes for any asset_id |
| **User own fills** | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | API key + secret + passphrase | confirmation of YOUR orders matched on chain |
| **Sports events** | `wss://sports-api.polymarket.com/ws` | none | live game state (score/period/ended) for sports markets |
| **RTDS (whale activity)** | `wss://ws-live-data.polymarket.com` | none | every trade on platform, raw firehose |

### Order placement

CLOB v2 SDK: `@polymarket/clob-client-v2` v1.0.2 + `viem` + `@polymarket/clob-order-utils`. Talk to `https://clob.polymarket.com` directly. Don't use CLOB v1 SDK — broken since 2026-04-27 with `order_version_mismatch`.

---

## Whale signal collection — recommended pipeline

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ RTDS firehose│ →  │ wallet match │ →  │ market enrich│ →  filter pipeline → BUY
└──────────────┘    └──────────────┘    └──────────────┘
       │                   │                  │
   every trade        whales DB          gamma+book
                      (1500+ wallets,
                       classified)
```

**Why RTDS over chain polling**: WS push is sub-second; chain `eth_getLogs` polling is 2-5s + RPC cost. v1 used both, v2 dropped chain listener.

### RTDS subscribe payload

```json
{ "type": "trades" }
```
That's it. Server pushes every trade as JSON object. No reply. Ping with empty string every 30s to keep connection.

Sample event:
```json
{
  "asset_id": "...",
  "condition_id": "0x...",
  "size": 152,
  "price": 0.66,
  "side": "BUY",
  "user": "0x84ad9c5c...",
  "timestamp": 1777779962,
  "transaction_hash": "0x...",
  "title": "mlb-nym-laa-2026-05-02"
}
```

### Match against whale corpus

Pre-load classified whale wallets at startup. v2 corpus has 1505 (1463 NOISE / 19 SNIPER / 11 INFORMED / 11 MARKET_MAKER / 1 UNCLASSIFIED). Source: v1 `output/wallet_profiles.json`. Each whale carries:
- `confidence` (0..1) — classifier confidence
- `classification` — INFORMED / SNIPER / FOLLOWER / NOISE / MARKET_MAKER / etc.
- `sm_score` (size-escalation), `trust_score` (long-term reliability)

Lookup by `lower(user)`. If unmatched → drop signal. v1 had a discovery loop building corpus over time; v2 inherits from v1 dump.

---

## Market book WS — production-grade subscribe

The single most important payload — without `custom_feature_enabled: true` Polymarket silently delivers no book snapshots. v2 wasted hours debugging this.

**Initial connect**:
```json
{
  "type": "market",
  "assets_ids": ["...token_id_1...", "...token_id_2..."],
  "custom_feature_enabled": true
}
```

**Mid-session add**:
```json
{
  "type": "market",
  "assets_ids": ["...new_id..."],
  "custom_feature_enabled": true,
  "operation": "subscribe"
}
```

**Mid-session unsubscribe**:
```json
{
  "operation": "unsubscribe",
  "assets_ids": ["...drop..."]
}
```

### Event shapes

**`book` event** (full top-of-book snapshot):
```json
{
  "market": "0x...",
  "asset_id": "...",
  "timestamp": "1777782659962",
  "hash": "...",
  "bids": [{"price": "0.66", "size": "240"}, ...],
  "asks": [{"price": "0.68", "size": "150"}, ...]
}
```
Notes: bids array sometimes UNSORTED — sort yourself by price desc before picking top. Same for asks ascending.

**`price_change` event** (multi-asset wrapper):
```json
{
  "event_type": "price_change",
  "market": "0x...",
  "price_changes": [
    {
      "asset_id": "...",
      "price": "0.38",
      "size": "642",
      "side": "BUY",
      "best_bid": "0.50",
      "best_ask": "0.51"
    },
    ...
  ]
}
```
**Critical**: don't try to rebuild book from individual deltas. Each entry has `best_bid` / `best_ask` already — use them directly.

**`best_bid_ask` event** (lighter than book):
```json
{
  "event_type": "best_bid_ask",
  "asset_id": "...",
  "best_bid": "0.66",
  "best_ask": "0.68",
  "timestamp": "..."
}
```

**Other events to handle**: `last_trade_price` (informational), `tick_size_change` (cache new tick to skip REST), `new_market` (informational).

### Asset_id quirk

Some events carry the token id as `asset_id`, others as `market`. Always normalize:
```ts
const assetId = ev.asset_id ?? ev.market ?? "";
if (!assetId) drop;
```

### Dead-book filter

Polymarket's "zombie" state emits `bid: 0.01` placeholders. Don't trust prices when `bid <= 0.02` — drop the event silently. Otherwise calibrator/decide_exit makes nonsense decisions.

### Heartbeat watchdogs (zombie detection)

Polymarket WS sometimes accepts connections, replies to PONG, but stops sending real events (GitHub polymarket/issues #292, #26). One ping watchdog isn't enough. Run two:

```
HEARTBEAT_TRACKER  — bumps on EVERY frame (incl. PONG). Threshold 30s. Catches dead socket.
DATA_TRACKER       — bumps ONLY on real book/price_change events. Threshold 45s. Catches zombie.
```

Either tripping → force `socket.close()` → reconnect loop fires. PING every 20s with random 0-5s jitter to desync multiple workers.

### Reconnect

Exponential backoff 2s→30s. On reconnect, re-subscribe ALL active assets in single batch (not individual messages) using initial-format payload (no `operation` field).

---

## User WS (own fills) — for closure confirmation

Subscribe payload (auth required — get API key from CLOB onboarding):
```json
{
  "type": "user",
  "auth": {"apiKey": "...", "secret": "...", "passphrase": "..."},
  "markets": ["0xConditionId1", "0xConditionId2", ...]
}
```

**Critical**: `markets` is REQUIRED. Empty list = silently no events. Re-list every market you have skin in on each reconnect.

Two event types:

**`trade` event** — your order matched:
```json
{
  "event_type": "trade",
  "type": "TRADE",
  "id": "...",
  "asset_id": "...",
  "market": "0x...",
  "side": "BUY",
  "size": "10",
  "price": "0.66",
  "status": "MATCHED",  // → MINED → CONFIRMED progression
  "taker_order_id": "your_order_id_if_taker",
  "maker_orders": [{"order_id": "your_order_id_if_maker", "matched_amount": "10", "price": "0.66"}],
  "transaction_hash": "0x..."
}
```

`status` progression: `MATCHED` → `MINED` → `CONFIRMED`. Only treat `CONFIRMED` (or `transaction_hash` present) as canonical "your money moved on chain". This is the INV-M3 closure rule from v2 spec — never close a position without on-chain confirmation.

**`order` event** — order lifecycle:
```json
{
  "event_type": "order",
  "type": "PLACEMENT" | "UPDATE" | "CANCELLATION",
  "id": "...",
  "original_size": "10",
  "size_matched": "5"
}
```

---

## Sports WS — game-end detection

`wss://sports-api.polymarket.com/ws`, no auth, no subscribe payload. Auto-streams every active game state.

Sample message:
```json
{
  "gameId": 10077773,
  "leagueAbbreviation": "mlb",
  "homeTeam": "NYM",
  "awayTeam": "LAA",
  "status": "InProgress",
  "score": "3-3",
  "period": "Top 9th",
  "live": true,
  "ended": false,
  "eventState": {"type": "mlb", "ended": false}
}
```

**Diff in memory**: keep last snapshot per `gameId`. Emit `score_change` / `period_change` / `game_ended` events when fields differ. Treat `ended=true` OR `status in {finished, final, ended, closed, complete, completed, ft}` as terminal.

Use case in v2: when `game_ended` and we have an open YES position on that game's market, force-exit via `sell_bid_aggr` before resolution drift (Gate 8.5 in `decide_exit`). Gives ~5-20% on losing-side captures.

---

## REST `/book` — fallback when WS not subscribed

```
GET https://clob.polymarket.com/book?token_id={asset_id}
```

Response:
```json
{
  "asset_id": "...",
  "bids": [{"price": "0.66", "size": "240"}, ...],
  "asks": [{"price": "0.68", "size": "150"}, ...],
  "timestamp": "1777782659962"
}
```

Same sort/normalize as WS book. **Cache top result for 500ms** in your hot path — Polymarket rate-limits modestly and v2 saw 200-400ms latency per call.

---

## Gamma — market metadata

```
GET https://gamma-api.polymarket.com/markets?clob_token_ids={asset_id}
```

Returns array of one market object per token. Key fields:
```json
{
  "conditionId": "0x...",
  "question": "Will Mets win?",
  "outcomes": "[\"Yes\", \"No\"]",          // JSON-string array
  "outcomePrices": "[\"0.45\", \"0.55\"]",  // JSON-string array
  "endDate": "2026-05-02T23:00:00Z",
  "active": true,
  "closed": false,
  "archived": false,
  "acceptingOrders": true,
  "negRisk": false,
  "orderPriceMinTickSize": 0.001,
  "orderMinSize": 5,
  "umaResolutionStatus": "proposed" | "disputed" | "resolved" | null,
  "gameId": 10077773,
  "sportsMarketType": "winner",
  "tags": [{"label": "Sports"}, ...]
}
```

`outcomes` and `outcomePrices` are JSON-encoded strings, not native arrays — `JSON.parse` them.

**Cache aggressively**: market metadata changes minutes-rarely. v2 uses 30s TTL.

---

## Data API — chain-truth positions

```
GET https://data-api.polymarket.com/positions?user={wallet}
```

Returns array. Use to reconcile DB-vs-chain shares (INV-D3). Eventual consistency 5-30s after a fill — apply grace period before flagging drift.

```
GET https://data-api.polymarket.com/activity?user={wallet}&limit=100
```

Returns last 100 activities (BUY/SELL/REDEEM). For backfill on startup if WS missed events.

---

## Gotchas summary (the things that cost real time to discover)

1. **`custom_feature_enabled: true`** — without it market WS sends nothing useful (silent failure mode)
2. **`asset_id` || `market` field** — use both as fallback
3. **`price_change` is wrapper** with `price_changes[]` array (not flat single delta)
4. **`best_bid`/`best_ask` already in payload** — don't reconstruct from deltas
5. **bids array unsorted** — sort yourself
6. **Dead-book bid≤0.02** — Polymarket placeholder, ignore
7. **PING + dual heartbeat** — single watchdog misses zombie state
8. **User WS needs `markets[]` populated** — empty = silent no-events
9. **`status: CONFIRMED` only** — never close on `MATCHED` alone (will reverse)
10. **CLOB V1 SDK broken** since 2026-04-27 — must use `@polymarket/clob-client-v2` 1.0.2+
11. **Order placement requires `expirationTs` ≥ now+90s** for GTD per Polymarket security threshold
12. **No `builder` field on orders** unless registered for Builder Program (we're not)
13. **`outcomes` / `outcomePrices` are JSON-strings** in gamma response, not arrays
14. **`/book` cache 500ms** — sub-tick cache helps PositionMonitor 2Hz tick without hammering REST

---

## Reference implementations in v2

Copy these files as starting points (TypeScript, MIT-equivalent license, no external dependencies beyond `ws` + standard Node):

- `src/feed/market_book_ws.ts` (444 LOC) — full market WS with v1-style heartbeat + zombie detection + dead-book filter + per-event-type counters
- `src/feed/sports_event_consumer.ts` (~270 LOC) — sports WS with diff-and-emit
- `src/feed/rtds_feed.ts` — RTDS subscriber
- `src/execute/fill_reconciler.ts` — user WS for own-fill confirmation
- `src/api/book.ts` — REST `/book` with TTL cache
- `src/api/gamma.ts` — gamma metadata fetch + parse
- `src/api/data.ts` — Data API positions/activity

All four feed services run as separate Node processes via systemd units (production: `ora2-feed`, `ora2-trader`, etc. on Hetzner). For dev, `tsx watch --env-file=.env src/feed/main.ts` runs the whole feed stack inline.

---

## Whale corpus seed

If you want our 1505 classified wallets as a starting corpus, take `output/wallet_profiles.json` from the v1 archive at `Moonkeemoo/ora-et-labora` (or grab the local backup `~/oralab-archives/hetzner-v1-snapshot-20260503.tar.gz`). Each entry:

```json
{
  "0x84ad9c5c...": {
    "classification": "INFORMED",
    "confidence": 0.7,
    "metrics": {
      "total_trades": 247,
      "win_rate": 0.61,
      "avg_hold_hours": 4.2,
      "size_escalation_score": 1.0,
      "directional_ratio": 0.55,
      "domain_concentration": 0.45,
      "domain_breakdown": {"Soccer": 120, "MLB": 80, ...}
    },
    "sports_domains": {"Soccer": 0.5, "MLB": 0.3, ...},
    "last_classified": 1777648277.7,
    "last_activity_ts": 1777800000.0
  }
}
```

Mapping into your DB: `confidence` is the canonical trust signal (0..1). Don't try to recompute trust from `win_rate * hold_hours` — that's 0 for 99% of entries since most lack completed cycles. We learned this the hard way (commit `d0e10c4` in oralab).

---

## Production-grade env vars (ours)

```
POLY_PRIVATE_KEY=0x...                 # private key for chain ops
POLY_WALLET_ADDRESS=0x...              # your wallet
POLY_API_KEY=...                       # CLOB API
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...
CLOB_URL=https://clob.polymarket.com
GAMMA_API_URL=https://gamma-api.polymarket.com
DATA_API_URL=https://data-api.polymarket.com
CLOB_WS_MARKET_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
CLOB_WS_USER_URL=wss://ws-subscriptions-clob.polymarket.com/ws/user
SPORTS_WS_URL=wss://sports-api.polymarket.com/ws
RTDS_WS_URL=wss://ws-live-data.polymarket.com
WS_PING_INTERVAL_MS=20000
WS_PING_JITTER_MAX_MS=5000
WS_HEARTBEAT_THRESHOLD_MS=30000
WS_DATA_SILENCE_THRESHOLD_MS=45000
WS_DEAD_BOOK_BID_THRESHOLD=0.02
WS_BOOK_MAX_AGE_MS=5000
SNAPSHOT_BOOK_TTL_MS=500
LIVE_ASK_CACHE_TTL_MS=500
```

---

## License + usage

This handoff is generated from production code at `Moonkeemoo/oralab` (TS, Postgres, Drizzle). All endpoints/payloads/quirks reflect 2026-05-03 production reality. Polymarket APIs evolve — verify against their docs at the time you read this.
