# Polymarket Live Trading — Operational Reference

Comprehensive reference for the JS/TS rewrite. Distilled from real prod
incidents and 4 months of bug-fix cycles on the Python implementation.

> ⚠️ **CLOB V2 reality (April 28, 2026):** Polymarket migrated to V2. New exchange contracts, new order struct (no `salt`/`nonce`/`feeRateBps`/`taker`; added `timestamp`/`metadata`/`builder`), new collateral (pUSD instead of USDC), no backward compatibility. Sections below marked with **[V1 LEGACY]** are superseded by V2 — see "CLOB V2 — what changed" section near the bottom of this doc and `docs/v2/clob-v2-research.html` for current details. Use `@polymarket/clob-client-v2` v1.0.2 + `viem` + `@polymarket/clob-order-utils`. The rest of this doc (data formats, WebSocket, lifecycle, gotchas) remains valid.

## API Surface (3 services)

### 1. CLOB API — `clob.polymarket.com`
Order placement + orderbook. Auth required for placement/cancel.

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /book?token_id=X` | no | `{bids, asks, market, asset_id, timestamp}` — for INV-D2 spread gate |
| `GET /order/{order_id}` | L2 HMAC | order status, size_matched, expiration |
| `POST /order` | L2 HMAC | place signed order |
| `POST /cancel` | L2 HMAC | cancel by order_id |
| `GET /orders` | L2 HMAC | our open orders |
| `GET /tick-sizes?token_id=X` | no | tick_size (0.001 or 0.01) |

**DO NOT use** `/midpoint?token_id=X` — stale/synthesized data, **cause of QA-180**. Use `/book` directly with top bid/ask.

### 2. Data API — `data-api.polymarket.com`
Chain truth for our wallet.

| Endpoint | Returns |
|---|---|
| `GET /positions?user=WALLET` | Current open on-chain positions |
| `GET /activity?user=WALLET&type=TRADE&limit=500&offset=N` | Historical trades, newest-first |

⚠️ **Default User-Agent gets 403.** Pass `User-Agent: Mozilla/5.0`.
⚠️ **Eventual consistency 5-30s** after actual on-chain fill.
⚠️ **`curPrice` = implied price (gamma-derived), NOT real bid.** Don't use for exit pricing.

### 3. Gamma API — `gamma-api.polymarket.com`
Market metadata.

| Endpoint | Returns |
|---|---|
| `GET /markets?clob_token_ids=X` | array of 1 — market for asset |
| `GET /markets/{condition_id}` | same direct by condition_id |
| `GET /events/{slug}` | event meta (for multi-market UMA) |

⚠️ **Don't confuse with `clob.polymarket.com/markets` — different APIs, different fields.** CLOB `/markets` once returned an unrelated NCAAB market from 2023 for our token_id (likely token reuse).

---

## Data Formats

### Position (`/positions` response item)
```json
{
  "proxyWallet": "0x...",
  "asset": "<token_id_decimal>",
  "conditionId": "0x...",
  "size": 11.84,
  "avgPrice": 0.37,
  "initialValue": 4.38,
  "currentValue": 2.72,
  "cashPnl": -1.66,
  "percentPnl": -38.0,
  "curPrice": 0.23,
  "redeemable": false,
  "mergeable": false,
  "title": "...",
  "outcome": "Nongshim Red Force",
  "outcomeIndex": 0,
  "oppositeOutcome": "Kiwoom DRX",
  "oppositeAsset": "<complement_token>",
  "endDate": "2026-05-02",
  "negativeRisk": false
}
```

### Activity (`/activity` response item)
```json
{
  "asset": "<token_id>",
  "conditionId": "0x...",
  "side": "BUY" | "SELL",
  "size": 11.83,
  "price": 0.23,
  "timestamp": 1777723448,
  "transactionHash": "0x...",
  "fee": 0,
  "title": "..."
}
```
**Realized PnL** = `Σ(SELLs.size×price) − Σ(BUYs.size×price) − fees`. Authoritative truth, **never trades.json**.

### Market (gamma-api/markets)
```json
{
  "question": "...",
  "slug": "...",
  "conditionId": "0x...",
  "active": true,
  "closed": false,
  "archived": false,
  "acceptingOrders": true,
  "enableOrderBook": true,
  "umaResolutionStatus": null | "proposed" | "disputed" | "resolved",
  "endDate": "2026-05-02T14:00:00Z",
  "outcomePrices": "[\"0.95\", \"0.05\"]",
  "outcomes": "[\"Yes\", \"No\"]",
  "tokens": [
    {"token_id": "<id>", "outcome": "Yes"},
    {"token_id": "<id>", "outcome": "No"}
  ],
  "orderPriceMinTickSize": 0.001,
  "orderMinSize": 5,
  "maker_base_fee": 1000,
  "taker_base_fee": 1000,
  "negRisk": false,
  "liquidity": 49261.47,
  "volume": 1328530.69
}
```

⚠️ **`outcomePrices` is JSON-encoded string.** Parse with `JSON.parse(market.outcomePrices)`.

### Orderbook (`/book`)
```json
{
  "market": "<condition_id>",
  "asset_id": "<token_id>",
  "bids": [{"price": "0.42", "size": "1500"}, ...],
  "asks": [{"price": "0.45", "size": "200"}, ...],
  "hash": "0x...",
  "timestamp": "1777..."
}
```

⚠️ **Polymarket does NOT guarantee ordering of bids/asks arrays.** Always `Math.max(...bids.map(b => Number(b.price)))` for top bid, `Math.min(...asks.map(a => Number(a.price)))` for top ask.
⚠️ **bid≤0.001 AND ask≥0.999 = dead orderbook.** INV-D2 should HOLD.

---

## Order signing & placement

### Contracts (Polygon mainnet, chainId=137)

**[V1 LEGACY]** — addresses below were V1 Exchange contracts. V2 launched April 28, 2026 with new addresses. Verify current V2 addresses from `@polymarket/clob-client-v2` source code or the official migration guide before using.

| Market type | V1 Exchange (legacy) | Domain |
|---|---|---|
| Binary (negRisk=false) | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | name="Polymarket CTF Exchange", version="1" |
| Multi-outcome (negRisk=true) | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | same |

⚠️ **In V2, wrong contract still produces a signing/placement error.** SDK selects by `negRisk` flag — **always pass explicitly from market metadata**, never auto-detect.

### Signature types
- `1` — relayer/proxy: signer (private key derived address) ≠ funder (magic wallet). What v1 bot uses; carries to V2 for solo flow.
- `2` — EOA/magic browser wallet.
- `3` (V2) — ERC-1271 smart contract wallet (Safe / AA). New in V2. Used for BYO-wallet multi-user flow in P3+.

### Signed order payload — V2

```json
{
  "maker": "0xba462127...",
  "signer": "0x186196aC...",
  "tokenId": "8791984...",
  "makerAmount": "10650000",
  "takerAmount": "479250",
  "expiration": "1777717704",
  "side": "SELL",
  "signatureType": 1,
  "signature": "0x...",
  "timestamp": "1714665600000",
  "metadata": "",
  "builder": "0x..."
}
```

**Removed in V2 (do NOT include):** `salt`, `nonce`, `feeRateBps`, `taker`.
**Added in V2:** `timestamp` (ms), `metadata` (optional tracking string), `builder` (attribution address — populate to participate in fee-revenue share).

### Signed order payload — V1 (LEGACY, kept for reference)

```json
{
  "salt": "335758649",
  "maker": "0xba462127...",
  "signer": "0x186196aC...",
  "taker": "0x0000000000000000000000000000000000000000",
  "tokenId": "8791984...",
  "makerAmount": "10650000",
  "takerAmount": "479250",
  "expiration": "1777717704",
  "nonce": "0",
  "feeRateBps": "1000",
  "side": "SELL",
  "signatureType": 1,
  "signature": "0x..."
}
```

⚠️ **CTF tokens = ERC-1155 with 1e6 decimals.** Not 1e18. pUSD (V2) and USDC (V1) both 1e6.

### Order types
- `FOK` — Fill-Or-Kill: must fully fill or reject (BUY entry)
- `FAK` — Fill-And-Kill: partial OK, leftover cancelled (BUY fallback)
- `GTD` — Good-Til-Date: limit with expiration_ts (SELL with 60s window)
- `GTC` — Good-Til-Cancel: limit, sits until cancelled (rare)

### Tick alignment
```ts
function roundDownToTick(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 1e-9) * tickSize;
}
```
SELL: round DOWN. BUY: round UP. Floating-point: always add `1e-9` epsilon.

### Common errors (mapping)
| API response | Meaning | Action |
|---|---|---|
| `order_version_mismatch` | wrong contract (negRisk) or wrong feeRateBps | re-fetch market, retry with correct prefs |
| `insufficient_balance` | size > free balance | pre-flight `/positions` minus reservations |
| `tick_size_mismatch` | price not aligned | re-round to tick |
| `post_only_rejected` | post_only=true and price matches market | undercut or disable post_only |
| `below_min_size` | size < orderMinSize | skip or bump |
| `expired` | expiration_ts ≤ now | re-stamp |

---

## WebSocket subscriptions

### Market WS (mark prices, orderbook)
`wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribe `{type: "Market", assets_ids: [token_ids]}`
- Receives `MarketUpdate` events: bids, asks, hash, timestamp

### User WS (own fills)
`wss://ws-subscriptions-clob.polymarket.com/ws/user`
- Auth via API creds
- Subscribe `{type: "User", auth: {apiKey, secret, passphrase}}`
- Receives `OrderFilled`, `OrderCanceled` events

### Mark WS (alternative simpler feed)
`wss://ws-subscriptions-clob.polymarket.com/ws/mark`
- Last-trade price stream

### Sports WS (V2 — real-time game state)
`wss://sports-api.polymarket.com/ws`
- **No auth required.** Connect and start receiving.
- **No subscribe message required.** Auto-streams all active sports events.
- Server sends `ping` every 5s — respond with `pong` within 10s or connection closes.
- Each message = JSON with: `gameId`, `league` (NFL/NHL/MLB/NBA/CBB/CFB/Soccer/Esports/Tennis), team names, score, period, game status.
- **Edge:** react to score changes faster than market price adjusts. Independent SignalSource for SportsScoreReactor strategy (P4+).

### Real-Time Data WS (V2 — RTDS for crypto markets)
`wss://ws-live-data.polymarket.com`
- TS SDK: `@polymarket/real-time-data-client`
- Streams crypto prices (Binance, Chainlink) + comments
- Useful for crypto markets bounded by spot prices (BTC, ETH thresholds)

⚠️ **WebSocket reconnect required** — server closes idle connections. Heartbeat + exponential backoff reconnect.
⚠️ **WS subscription limit** — ~50 tokens per connection on `/ws/market`. Multiple connections for wider scope. Sports WS and RTDS have no per-token limit (different model).

---

## Live trading lifecycle

### Entry (whale BUY → our copy)
1. **Detection** — chain listener sees `OrderFilled(whale, asset, BUY)` OR whale_alerts WS
2. **Match** — whale_address in tracked list? If no, drop
3. **Filter pipeline** — N filter checks (conviction, market quality, exposure)
4. **Sizing** — `size_usd = base × conviction_mult`, capped by `max_entry_shares × price`
5. **Market lookup** — gamma-api for tick_size, min_size, fee, negRisk
6. **Sign + post** — FOK via `client.createAndPostOrder({...}, {tickSize, negRisk}, OrderType.FOK)`
7. **Monitor fill** — wait for on-chain fill via chain listener (5-30s)
8. **Persist** — INSERT into positions, status=PENDING → FILLED → OPEN

### Exit (V2 decision-loop)
1. **Tick @ 2Hz** — for each OPEN position:
   - Read mark from WS book (with freshness check)
   - Read real bid/ask from `/book` (with 3s TTL cache)
   - Read `/positions` for on-chain truth (with 5s TTL cache)
   - Read gamma-api outcome odds (for outcome floor)
2. **`decide_exit(pos, snap, cfg) → ExitIntent`** (pure function)
3. **If HOLD/FREEZE/REDEEM** — do nothing
4. **If SELL_*** — `client.createAndPostOrder({...}, {tickSize, negRisk}, OrderType.GTD, expiration=now+60)`
5. **Monitor fill** — chain listener sees SELL → set closure_reason + budget release
6. **If GTD expired without fill** — next tick decide_exit produces fresh intent

### Resolution (market closes)
1. Gamma `closed=true` OR `umaResolutionStatus=resolved`
2. If UMA `proposed`/`disputed` — position is **LOCKED** (HOLD; no sell, no redeem)
3. If `resolved` AND we hold winning outcome → call `redeemPositions` on CTF contract
4. If losing outcome → shares burn to $0

### Reconciliation (continuous)
1. **Startup** — query `/activity` for wallet → close any OPEN entries with matching SELL
2. **Per-tick** — `/positions` diff vs local DB. Mismatch >5% size → freeze trade
3. **Post-close** — pnl_verifier computes `Σ activity` for condition_id, writes chain_realized_pnl
4. **Phantom detection** — local OPEN without on-chain BUY > 5min → mark false_positive

---

## Critical gotchas (must-document)

1. **negRisk flag must come from gamma-api, not assumed** — Sports markets selectively. Wrong = order rejection.
2. **fee_rate_bps must come from gamma maker_base_fee** — SDK auto-resolve can cache stale data. Take from market metadata.
3. **`/midpoint` endpoint is stale source** — use `/book` directly (QA-180).
4. **`curPrice` from `/positions` ≠ exit price** — implied. Real exit = top bid (QA-166).
5. **Tick alignment FLOAT pitfall** — `0.045 / 0.001 = 44.99999999`. Always `+1e-9` epsilon before `Math.floor`.
6. **Polymarket array order undefined** — bids may be desc OR asc. `Math.max(...prices)`.
7. **`/positions` eventual consistency** — after our BUY/SELL wait 5-30s for visibility.
8. **POLY_WALLET_ADDRESS ≠ PK-derived address** — for proxy mode funder is one, signer another. SDK config: `funder = WALLET_ADDRESS`, `signer = derived from PK`.
9. **outcomePrices is JSON-encoded string** — `JSON.parse(market.outcomePrices)`.
10. **Default User-Agent blocked by data-api** — set `Mozilla/5.0`.
11. **Min order size 5 for most, 15 for some** — gamma `orderMinSize`.
12. **Expiration must be future** — GTD with expiration ≤ now → 400.
13. **WebSocket reconnect required** — heartbeat + exponential backoff.

---

## Required env vars (deployment — P1 solo)

```bash
# Signing (single-user P1; multi-user P3+ keeps this for backend signing of custodial wallets)
POLY_PRIVATE_KEY=0x...
POLY_WALLET_ADDRESS=0xba462127...

# CLOB API auth
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...

# V2 — builder rewards (register address, populate on every order)
POLY_BUILDER_ADDRESS=0x...

# Network
CHAIN_ID=137
CLOB_URL=https://clob.polymarket.com
DATA_API_URL=https://data-api.polymarket.com
GAMMA_API_URL=https://gamma-api.polymarket.com
SPORTS_WS_URL=wss://sports-api.polymarket.com/ws
RTDS_WS_URL=wss://ws-live-data.polymarket.com

# RPC fallbacks (chain listener)
POLYGON_RPC_URLS=https://rpc1,https://rpc2,...

# P3+ multi-user (custodial flow only — KMS or libsodium master key)
CUSTODIAL_MASTER_KEY=...
```

## pUSD — collateral in V2

V2 changed collateral from USDC directly to **pUSD**: a regular ERC-20 on Polygon backed 1:1 by USDC. Smart contract enforces 1 pUSD ↔ 1 USDC convertibility with no fees.

**P1 (solo, Taras):** convert USDC → pUSD manually outside the bot once. Display balance in pUSD internally; convert for UI if confusing.

**P3+ (multi-user):** custodial flow auto-converts on deposit. BYO flow: user already has pUSD or knows to convert. Onboarding screen explains both.

**Fees in V2:** charged in USDC (separate from collateral) at order match-time, not in shares at order placement. Budget tracking accounts for USDC fee post-fill, not pre-fill.

---

## SDK call template (TypeScript)

```ts
import { ClobClient, Side, OrderType, ApiCreds } from "@polymarket/clob-client-v2";
import { ethers } from "ethers";  // or viem signer

const signer = new ethers.Wallet(process.env.POLY_PRIVATE_KEY!);
const creds: ApiCreds = {
  key: process.env.POLY_API_KEY!,
  secret: process.env.POLY_API_SECRET!,
  passphrase: process.env.POLY_API_PASSPHRASE!,
};

const client = new ClobClient(
  process.env.CLOB_URL!,
  Number(process.env.CHAIN_ID),
  signer,
  creds,
  1,  // signatureType = relayer/proxy
  process.env.POLY_WALLET_ADDRESS!,
);

// 1. Fetch market for negRisk + tickSize
const markets = await fetch(
  `${GAMMA_API_URL}/markets?clob_token_ids=${tokenId}`,
).then(r => r.json());
const m = markets[0];
const negRisk: boolean = m.negRisk;
const tickSize: string = String(m.orderPriceMinTickSize);

// 2. Place GTD SELL
const expiration = Math.floor(Date.now() / 1000) + 60;
const resp = await client.createAndPostOrder(
  {
    tokenID: tokenId,
    price: 0.42,
    side: Side.SELL,
    size: 11.84,
    expiration,
  },
  { tickSize, negRisk },
  OrderType.GTD,
  /* postOnly */ false,
);

// resp shape: { success: bool, errorMsg?: string, orderID?: string,
//               status?: "LIVE"|"DELAYED"|"MATCHED", takingAmount?: string }
if (!resp.success) {
  // Map errorMsg to structured error_code
}
```

---

## Rate limits (informal observations)

| API | Approx ceiling | Strategy |
|---|---|---|
| `/positions` | ~10 req/s | TTL cache 3-5s; batch wallet-wide fetch, not per-asset |
| `/activity` | ~10 req/s | Cache by condition_id; refresh on demand |
| gamma-api | ~20 req/s | Cache market metadata permanently (rare updates) |
| `/book` | use WS | TTL 2-3s if REST |
| WS subscriptions | ~50 tokens/connection | Multiple connections for wider scope |
