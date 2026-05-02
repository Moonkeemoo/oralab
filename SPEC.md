# Bot Constitution — Architectural Rules for the Rewrite

Distilled from V2 design + 4 months of bug-fix experience. This is the
north star for any new code. Every PR re-reads this; no exceptions.

## Mission (one paragraph)

Listen to whale wallets trading on Polymarket via on-chain events and
WebSocket; copy their entries through a multi-stage filter pipeline that
scores conviction, trust, and intent; place an FOK BUY when filters pass;
manage exits via TP/SL/trailing logic that respects on-chain liquidity
reality (not synthetic mark prices); close positions only after on-chain
SELL fill confirmation or market resolution. Never trust local state over
chain truth.

---

## The 10 Invariants (constitution)

These cannot be violated. Every code path is reviewed against them.
Watchdog rules enforce as backstop.

### Money-safety (5 — violation = real money loss)

**INV-M1. Never sell more than on-chain shares.**
- Pre-flight balance check before EVERY order via `/positions` or `getBalanceAllowance`.
- Order.size = `min(intent.size, free_size, on_chain_size)`.
- Watchdog rule R21 backstops via lifecycle event audit.

**INV-M2. Never sell below outcome floor.**
- `floor = max(min_tick, expected_outcome_value × 0.3)`.
- `expected_outcome_value` = parsed `gamma_api.outcomePrices[our_side_index]`.
- Order rejected if `price < floor`.
- Watchdog R22 backstops.

**INV-M3. Closure ONLY via on-chain SELL fill OR UMA-resolved.**
- Two paths only: (a) `/activity` shows our SELL with matching tx hash; (b) `market.umaResolutionStatus === "resolved"` AND we redeemed.
- Forbidden: price_resolved/phantom_external/timeout closures.
- `closure_reason` is a TERMINAL flag — never write before fill confirmation (QA-181).

**INV-M4. Atomic budget transaction.**
- `_entry_costs[id]` + `_exited_ids` flip + `spent_usd` recompute → single atomic write.
- On crash mid-update → next startup reconciliation detects delta.
- Watchdog R9 catches drift.

**INV-M5. Never double-act on same trade.**
- State machine VALID_TRANSITIONS enforced. EXITING → EXITING forbidden.
- Every exit_executor call starts with `if state !== "exiting" return`.

### Data correctness (3 — violation = wrong decision based on lies)

**INV-D1. Source-of-truth hierarchy, never otherwise.**

| Question | Truth | Cache |
|---|---|---|
| Do we have a position? | `/positions` | trades DB (label "local") |
| Realized PnL? | `/activity` arithmetic | pnl_amount (label "local") |
| Outcome odds? | `gamma-api.outcomePrices` | — |
| Bid/Ask? | `clob.polymarket.com/book` | WS cache (with age) |
| Market state? | `gamma-api.acceptingOrders` | — |
| Wallet balance? | `client.getBalanceAllowance()` | local cache (label "local") |

- All log/dashboard/Telegram messages about PnL/positions explicitly labeled "verified" or "local-only".

**INV-D2. Mark staleness gate before SL/TP fire.**
- `decide_exit` returns HOLD if `mark_age_s > 60` OR `bid <= 0` OR `ask >= 1` OR `spread/midpoint > 50%`.
- WS-book mark in first 5s post-fill ignored (debounce — d847559e pattern).
- Spread gate uses REAL orderbook bid/ask (QA-180), never synthesized from mark.

**INV-D3. Continuous reconciliation, not just startup.**
- Position monitor 2Hz cycle starts with `/positions` diff vs local DB.
- Mismatch >5% size → freeze trade for SL fires + alert P1.
- Reconciler runs every tick, not only startup.

### Operational (2 — violation = bot stuck or wrong path)

**INV-O1. Bridge fallback with circuit breaker.**
- HTTP `/health` every 30s. >2 consecutive fails → fallback path for known-good markets only.
- Other markets: block new entries; existing exits via emergency path with `accept_loss=true`.
- (Native JS rewrite removes Python+bridge IPC — replace with circuit-breaker around CLOB SDK calls.)

**INV-O2. Bounded operations: timeout + retry + idempotency.**
- Every HTTP/RPC call: `timeout=5s`, retry 3× with exponential backoff.
- Order placement = idempotent via `client_order_id`.
- Cancel = idempotent (404 = OK if already swept/expired).

---

## State Machine

Single source of truth: enum types in code, no string status guessing.

```
PENDING → FILLED → OPEN → EXITING → CLOSED
                       ↓
                   RESOLVED → CLOSED
                       ↑
PENDING → FAILED (→ FILLED for ghost recovery)
EXITING → OPEN (sell retry rollback)
```

### Allowed transitions (VALID_TRANSITIONS)

| From | To allowed |
|---|---|
| PENDING | FILLED, FAILED |
| FILLED | OPEN |
| FAILED | FILLED (ghost), CLOSED |
| OPEN | EXITING, RESOLVED |
| EXITING | CLOSED, OPEN (rollback) |
| RESOLVED | CLOSED |
| CLOSED | (terminal) |

### Closure conditions (only these reach CLOSED)
- On-chain SELL fill confirmed via `/activity` matching tx_hash
- Market resolved + we redeemed (RESOLVED → CLOSED)
- Order failed pre-fill (PENDING → FAILED → CLOSED if no recovery)

---

## Exit decision tree (`decide_exit` priority order)

Pure function `decide_exit(pos: PositionView, snap: MarketSnapshot, cfg: ExitConfig) → ExitIntent`. No I/O, no side effects, deterministic.

1. INV-D3 reconciliation_conflict → **FREEZE**
2. market RESOLVED → **REDEEM**
3. on-chain size = 0 → **HOLD** (INV-M1)
4. UMA window / NOT_ACCEPTING / CLOSED → **HOLD**
5. INV-D2 post-entry WS_BOOK debounce 5s → **HOLD**
6. INV-D2 mark stale or wide spread → **HOLD**
7. SL emergency (-19%): sweep<max → bid+1tick; sweep>=max → FOK at floor
8. TP (+18%): bid+1tick GTD
9. trailing armed + giveback breach: bid+1tick GTD
10. SL standard (-10%): sweep<max → bid+1tick; sweep>=max → bid-1tick aggressive
11. default → **HOLD**

Every SELL branch filtered through `_outcome_floor` (INV-M2). If `price < floor` → HOLD.

---

## ExitIntent shape

```ts
type ExitAction =
  | "hold"               // do nothing this tick
  | "sell_bid_probe"     // GTD@bid+1tick, 60s — first attempt
  | "sell_bid_aggr"      // GTD@bid-1tick, 60s — eat spread (post-sweep)
  | "sell_fok"           // FOK at any price >= floor — last resort
  | "redeem"             // market resolved; CTF redeemPositions
  | "freeze";            // reconcile conflict; halt action

interface ExitIntent {
  action: ExitAction;
  price: number;          // limit price; 0 for HOLD/FREEZE/REDEEM
  size: number;           // shares; 0 for HOLD/FREEZE
  urgency: 1 | 2 | 3 | 4 | 5;  // 1=lazy, 5=immediate
  reason: string;         // human-readable cause
  gates: string[];        // invariant IDs that fired (audit)
  snapshotTs: number;
}
```

---

## What changes vs old Python implementation

| Old (Python) | New (TS) |
|---|---|
| Python + Node bridge sidecar | TypeScript native, `@polymarket/clob-client-v2` direct |
| JSON files with `os.replace()` | better-sqlite3 with transactions |
| 5 modules fight for exit truth | 1 pure `decide_exit` + 1 executor |
| Multiple closure paths (`price_resolved`, `phantom_external`, etc) | 2 paths only: chain SELL filled / market resolved |
| `pnl_verifier` rewrites local state | observability only, no mutation |
| `trade_reconciler.rollback` | continuous /positions diff + freeze |
| Implicit globals via `_cfg` / `_deps` | explicit dependency injection, typed |
| Status as string | discriminated union types |
| Filter pipeline tightly coupled | pure function array, composable |

---

## What stays from old project

- Bridge sidecar logic (concept) — re-implement directly in TS
- Filter pipeline structure (only living hard-filters, audit confirms which) — keep design
- Watchdog daemon + rules — keep, port rule logic to TS
- Calibrator (5-layer system: trace/kpi/attribution/whale/conv/bayesian) — port to TS in P2 with mobile-friendly insight rendering for Mini App
- 31 V1 invariants → distilled into 10 V2 invariants above

---

## Roadmap context (P-level scope)

This SPEC describes the trading core. The roadmap brackets it:

- **P1 (weeks 1–3)** — solo bot. Single user (Taras), single env-driven wallet. Schema is multi-user-shaped (every state row has `user_id` with default 1) but only one user exists. All 10 invariants enforced.
- **P2 (weeks 4–5)** — Mini App + bot + Calibrator port. Still solo. UI English-only.
- **P3 (weeks 6–11)** — multi-user platform. Real `users` + `wallets` tables. BYO smart-wallet flow (ERC-1271, V2-unlocked) + custodial encrypted-PK flow. Per-user balance/budget/positions isolation. Invariants M1/M4/D3 become per-user.
- **P4+** — new alpha. SportsScoreReactor (Polymarket sports WS feed) + SportsPreEventStrategy (external odds). Both plug in via Strategy abstraction without touching trading core.

This SPEC's invariants apply identically to solo and multi-user — the only difference is that "wallet" / "balance" / "position" all become per-user-scoped in P3.

---

## CLOB V2 reality

V2 launched April 28, 2026. Order struct lost `salt`, `nonce`, `feeRateBps`, `taker`; gained `timestamp`, `metadata`, `builder`. Collateral changed USDC → pUSD. v1 SDKs broken (`order_version_mismatch` from April 27). Use `@polymarket/clob-client-v2` v1.0.2 + `viem` + `@polymarket/clob-order-utils`. ERC-1271 supported (smart wallets first-class) — this is what makes BYO multi-user clean in P3. Builder field unlocks fee-revenue share — register builder address in P1.

Full research: `docs/v2/clob-v2-research.html`.

---

## Test pyramid (mandatory)

**Unit:** 100% branch coverage on `decide_exit` and every SELL-path predicate.
**Property (`fast-check`):** 1000+ random snapshots — all 10 INVs hold for any input.
**Replay:** historical lifecycle events through `decide_exit` — no premature SLs, no fake closures.
**Integration:** mocked CLOB SDK, full happy-path BUY → MARK → SELL → CLOSE.
**Adversarial:** stale data, dust bid, partial fills, network drop, concurrent same-asset trades.

---

## Acceptance gates before live trading

1. Unit + property + replay all green
2. Integration test on testnet/mock with 100 round-trips
3. Watchdog rules deployed and silent for 6h soak
4. Code review against this SPEC.md (every INV referenced)
5. Manual sign-off on first 5 live trades

---

## Non-negotiables (red lines)

- **Never** write `closure_reason` outside confirmed fill or resolution
- **Never** sell below `_outcome_floor`
- **Never** trust local state over chain when they conflict
- **Never** sell more shares than `getBalanceAllowance` reports free
- **Never** silently swallow CLOB errors — every fail has a structured `error_code`
- **Never** ship a path that bypasses `decide_exit` for SELL decisions
- **Never** deploy without unit + property + replay tests passing

---

## Reference docs (in this directory)

- `SPEC.md` — this file (constitution)
- `POLYMARKET_API.md` — API surface, data formats, signing, gotchas
- `TESTS.md` — top critical QA patterns as negative tests for new code
