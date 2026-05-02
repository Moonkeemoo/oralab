# REPO_KICKOFF — Hand-off to Claude Code

> **Read me first.** This doc orients Claude Code (or any new collaborator) on the v2 build. It points to the substantive design docs but is itself self-contained enough to start week-1 work.

**Project:** Ora et Labora v2 — TypeScript-native Polymarket trading bot, sports-focused, on CLOB V2.
**State as of 2026-05-02:** all planning artifacts complete. Zero code written. User preparing the repo. This doc is the hand-off.

---

## 1. Reading order

Read in this order before writing any code:

| # | File | Why |
|---|------|-----|
| 1 | `docs/v2/architecture.html` | Master design. 18 sections. Dark-theme HTML — open in browser. |
| 2 | `docs/rewrite/SPEC.md` | Constitution. 10 invariants, decide_exit, state machine, ExitIntent, red lines. |
| 3 | `docs/v2/clob-v2-research.html` | CLOB V2 reality (launched April 28, 2026). What's new, what broke, what's unlocked. |
| 4 | `docs/rewrite/POLYMARKET_API.md` | API surface — order struct V2, contracts, SDK template, sports WS, pUSD, env vars. |
| 5 | `docs/rewrite/TESTS.md` | 30 critical QA patterns. Each is a failing test before any code. |
| 6 | `docs/rewrite/CLAUDE_SETUP.md` | Claude collaboration config — agents, hooks, memory seeds, workflow patterns. |
| 7 | This file | Concrete first actions. |

**Total reading time:** ~45 min. Worth it. The 10 V2 invariants alone represent 31 v1 production incidents.

---

## 2. Quick orientation (one paragraph)

Sports-focused Polymarket auto-trading bot. Listens to whale wallets via on-chain events + WebSocket; copies entries through filter pipeline; manages exits via `decide_exit` pure function; closes only on confirmed on-chain SELL fill or market resolution. **P1 = solo bot for one user (Taras), sports markets only, on CLOB V2.** **P1.5 (week 4)** adds SportsScoreReactor for alpha from Polymarket's sports WS feed. **P2** ships Telegram Mini App + bot. **P3c (week 11+)** opens to multi-user with BYO non-custodial smart wallets (ERC-1271, V2-unlocked) + custodial opt-in. Schema is multi-user-shaped from Day 1 to avoid migrations later.

Two north stars:
- Architectural: "least problems in LIVE, nothing gets stuck"
- Product: "alpha capture starts week 4, not week 8"

---

## 3. Tech stack (final, post PO+Architect review)

| Layer | Choice |
|---|---|
| Runtime | Node 22 LTS (Bun deferred to P5+) |
| HTTP | Hono |
| DB | PostgreSQL 16 from Day 1 (NOT SQLite) |
| ORM | drizzle-orm + drizzle-kit |
| Polymarket SDK | `@polymarket/clob-client-v2` v1.0.2 |
| Wallet / signing | `viem` + `@polymarket/clob-order-utils` |
| Real-time | native `ws` + `@polymarket/real-time-data-client` (P4+) |
| Telegram bot | grammY |
| Mini App frontend | SvelteKit + `@twa-dev/sdk` + Tailwind on Cloudflare Pages |
| Validation | zod |
| Observability (Day 1) | OpenTelemetry + Prometheus + Loki + Grafana on Hetzner |
| Tests | vitest + fast-check |
| Lint / format | biome |
| Calibrator service | Python (port v1) OR TS — out of trading hot path, P3+ |
| Process supervisor | systemd on Hetzner |
| Reverse proxy | Caddy (existing) — adds `/api` route |
| Static frontend | Cloudflare Pages |

**TypeScript discipline:** strict mode (no `any`, no implicit any, no unchecked indexes). Discriminated unions for status — never string status. `decide_exit` MUST be pure (no I/O, no side effects).

---

## 4. Proposed repo structure

```
ora-et-labora-v2/
├── README.md                  # short — point to docs/
├── CLAUDE.md                  # orientation map (template below)
├── package.json
├── tsconfig.json              # strict
├── biome.json
├── drizzle.config.ts
├── .env.example               # template (real .env in .gitignore)
├── .gitignore
├── docs/
│   ├── INVARIANTS.md          # copy from rewrite/SPEC.md (or symlink)
│   ├── API.md                 # copy from rewrite/POLYMARKET_API.md
│   ├── TESTS.md               # copy from rewrite/TESTS.md
│   ├── architecture.html      # copy from v2/architecture.html
│   └── clob-v2-research.html  # copy from v2/clob-v2-research.html
├── src/
│   ├── types/
│   │   ├── decide.ts          # ExitAction, ExitIntent, ExitConfig (port from SPEC.md)
│   │   ├── position.ts        # PositionView, status state machine
│   │   ├── market.ts          # MarketSnapshot, Market metadata
│   │   ├── signal.ts          # Signal, SignalSource interface
│   │   └── strategy.ts        # Strategy interface
│   ├── db/
│   │   ├── schema.ts          # drizzle schemas (users, wallets, positions, etc.)
│   │   ├── client.ts          # postgres connection
│   │   └── migrations/
│   ├── decide.ts              # decide_exit pure function — single source of exit truth
│   ├── execute/
│   │   ├── executor.ts        # ExitExecutor — only thing that mutates state
│   │   ├── order_manager.ts   # FOK BUY + GTD SELL via clob-client-v2
│   │   ├── fill_reconciler.ts # User WS → fills table
│   │   └── budget.ts          # atomic budget transactions
│   ├── feed/
│   │   ├── market_ws.ts       # market WS subscriber
│   │   ├── user_ws.ts         # user WS subscriber (own fills)
│   │   ├── chain_listener.ts  # viem-based on-chain event reader
│   │   └── sports_ws.ts       # P1.5 — sports-api.polymarket.com/ws
│   ├── strategies/
│   │   ├── base.ts            # Strategy interface
│   │   ├── whale_follow.ts    # P1
│   │   └── sports_score_reactor.ts  # P1.5
│   ├── filters/
│   │   ├── pipeline.ts        # composable filter array
│   │   ├── *.ts               # individual filters (port living ones from v1)
│   │   └── registry.ts        # filter registration
│   ├── monitor/
│   │   ├── position_monitor.ts # 2 Hz tick
│   │   └── reconciler.ts       # INV-D3 reconciliation algorithm
│   ├── api/
│   │   ├── clob.ts            # @polymarket/clob-client-v2 wrapper
│   │   ├── gamma.ts           # gamma-api client
│   │   ├── data.ts            # data-api client (positions, activity)
│   │   └── circuit_breaker.ts # INV-O1
│   ├── obs/
│   │   ├── tracer.ts          # OpenTelemetry tracer
│   │   ├── metrics.ts         # Prometheus exporter
│   │   └── logger.ts          # structured logging → Loki
│   ├── watchdog/
│   │   ├── rules/             # R-rules ported from v1
│   │   └── daemon.ts
│   ├── server/                 # P2 — ora2-api Hono service
│   │   ├── routes/
│   │   └── ws.ts
│   ├── bot/                    # P2 — ora2-bot grammY service
│   │   └── handlers/
│   ├── mini_app/               # P2 — SvelteKit (separate package, deployed CF Pages)
│   │   └── ...
│   └── main.ts                 # ora2-trader entry
├── tests/
│   ├── decide.spec.ts          # 100% branch + property + replay (vitest + fast-check)
│   ├── invariants/             # one test per V2 invariant (M1-M5, D1-D3, O1-O2)
│   ├── qa_patterns/            # one test per QA pattern from TESTS.md
│   ├── replay/                 # historical capture replay
│   └── integration/            # mocked CLOB + happy-path BUY → MARK → SELL → CLOSE
├── scripts/
│   ├── setup-postgres.sh       # local dev DB
│   ├── run-trader.sh
│   ├── run-feed.sh
│   ├── run-watchdog.sh
│   └── seed-strategies.ts      # seed initial strategy + whales (sports)
└── infra/
    ├── systemd/                # ora2-*.service files
    ├── caddy/                  # /api route addition
    └── otel-collector.yaml     # observability config
```

---

## 5. Initial `CLAUDE.md` for the new repo (ready to paste)

```markdown
# CLAUDE.md — Ora et Labora v2

> Sports-focused Polymarket auto-trading bot. TypeScript native. CLOB V2.
> North star: "least problems in LIVE, nothing gets stuck" + "alpha capture week 4 not week 8".

## What this project does

Listens to whale wallets via on-chain events + WebSocket; copies entries through filter pipeline; manages exits via `decide_exit` pure function; closes only on confirmed on-chain SELL fill or market resolution. P1 = solo bot, sports-only. P1.5 = SportsScoreReactor. P2 = Mini App. P3c = multi-user platform.

## Architecture (one screen)

```
External: Polymarket WS · Polygon RPC · CLOB V2/Gamma/Data REST · Sports WS · Telegram

Hetzner services: ora2-feed → ora2-trader → ora2-api → ora2-bot · ora2-watchdog · OTEL stack

DB: PostgreSQL 16 (single source of truth)

Frontend: Mini App on Cloudflare Pages (oralab.xyz/app)
```

Full design: `docs/architecture.html`. Constitution: `docs/INVARIANTS.md`. API: `docs/API.md`.

## Critical rules (top 7 — full list in SPEC)

| # | Rule | If violated |
|---|------|------------|
| INV-M1 | Never sell more than on-chain shares | order rejection / oversell |
| INV-M2 | Never sell below outcome floor | dump value at dust prices |
| INV-M3 | Closure only via chain SELL filled OR resolved | orphan position |
| INV-D1 | Source-of-truth hierarchy (positions/activity/gamma/book) | wrong PnL display |
| INV-D2 | Mark staleness gate before SL/TP | false SL on stale data |
| INV-D3 | Continuous reconciliation w/ grace periods | drift accumulates |
| INV-O2 | Bounded ops: timeout + retry + idempotent | bot stuck |

## Conventions

- **TypeScript strict** — no any, no implicit any, no unchecked indexes
- **Discriminated unions** for status — never string status
- **Pure functions where possible** — `decide_exit` MUST be pure
- **Postgres + drizzle** — never JSON files for state
- **vitest + fast-check** — coverage 95%+ on `decide.ts`
- **viem** for chain — typed events, modern patterns
- **Platform UI in English; Claude ↔ Taras collaboration in Ukrainian**
- **No bridge sidecar** — TS calls @polymarket/clob-client-v2 directly
- **Builder field populated on every order** — register `POLY_BUILDER_ADDRESS`

## Phase plan (one screen)

| Phase | Weeks | What |
|---|---|---|
| Spike | 1 | scaffold + observability + 3 spikes (filter audit, builder rewards, competitive) |
| P1 | 2-3 | solo bot foundation, sports-only, all DRY |
| P1.5 | 4 | SportsScoreReactor minimum (alpha capture starts) |
| P2a | 5 | Mini App + bot |
| P2b | 6 | decision log capture |
| P3a | 7 | DRY parallel run, 7 days hard gate |
| P3b | 8 | LIVE migration solo |
| Wks 9-10 | — | solo LIVE stability + pricing waitlist |
| P3c | 11-12 | multi-user closed beta (BYO primary, custodial opt-in) |
| P3d | 13-14 | open beta |
| P4+ | mo 4+ | full sports + crypto + calibrator + monetization |

## Running

```bash
npm install
docker-compose up -d postgres   # or local postgres
npm run db:migrate
npm run dev:trader              # ora2-trader
npm run dev:feed                # ora2-feed
npm run dev:watchdog            # ora2-watchdog
npm test                        # full vitest suite
npm test -- --coverage          # coverage report
```

## Tooling

### Agents
- **product-qa** — bug pattern recorder (LEARN mode on commits to src/)
- **trader-watchdog** — read-only journal tail + ops alerts

### Skills
- brainstorming → writing-plans → executing-plans — for new features only
- test-driven-development — always for `decide.ts` changes
- systematic-debugging — when bugs appear
- code-review — before merging to main

### Static checks
- `tsc --noEmit` (strict)
- `biome check`
- `npm test` (coverage threshold)

## Maintenance triggers

Update this file when:
- New top-level directory added
- New invariant discovered (also update SPEC)
- New agent or MCP tool added
- Convention change

Skip for: bugfixes, tests, dashboard UI tweaks.
```

---

## 6. `.env.example`

```bash
# === Polymarket signing (P1 solo) ===
POLY_PRIVATE_KEY=0x...
POLY_WALLET_ADDRESS=0xba462127...

# === CLOB API auth ===
POLY_API_KEY=
POLY_API_SECRET=
POLY_API_PASSPHRASE=

# === V2 builder rewards ===
POLY_BUILDER_ADDRESS=0x...

# === Network ===
CHAIN_ID=137
CLOB_URL=https://clob.polymarket.com
DATA_API_URL=https://data-api.polymarket.com
GAMMA_API_URL=https://gamma-api.polymarket.com
SPORTS_WS_URL=wss://sports-api.polymarket.com/ws
RTDS_WS_URL=wss://ws-live-data.polymarket.com

# === RPC fallbacks ===
POLYGON_RPC_URLS=https://polygon-rpc.com,https://rpc-mainnet.matic.network

# === DB ===
DATABASE_URL=postgresql://ora:ora@localhost:5432/ora_v2

# === Telegram (P2) ===
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=        # comma-separated; P1 solo: just Taras's id

# === Observability ===
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_SERVICE_NAME=ora2-trader     # set per-service in systemd unit

# === Modes ===
DRY_RUN=true                      # P1 starts DRY; P3b flips to false
KILL_SWITCH=false

# === P3c multi-user (custodial only) ===
CUSTODIAL_MASTER_KEY=             # libsodium master; activate at P3c kickoff
```

---

## 7. `package.json` sketch

```json
{
  "name": "ora-et-labora-v2",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev:trader": "tsx watch src/main.ts",
    "dev:feed": "tsx watch src/feed/main.ts",
    "dev:watchdog": "tsx watch src/watchdog/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "lint": "biome check .",
    "format": "biome format --write .",
    "db:migrate": "drizzle-kit push",
    "db:studio": "drizzle-kit studio"
  },
  "dependencies": {
    "@polymarket/clob-client-v2": "^1.0.2",
    "@polymarket/clob-order-utils": "latest",
    "@polymarket/real-time-data-client": "latest",
    "viem": "^2",
    "hono": "^4",
    "@hono/node-server": "^1",
    "drizzle-orm": "^0.30",
    "postgres": "^3",
    "grammy": "^1",
    "ws": "^8",
    "zod": "^3",
    "@opentelemetry/api": "^1",
    "@opentelemetry/sdk-node": "^0.50",
    "@opentelemetry/auto-instrumentations-node": "^0.45",
    "pino": "^8"
  },
  "devDependencies": {
    "typescript": "^5.4",
    "tsx": "^4",
    "vitest": "^1",
    "fast-check": "^3",
    "@vitest/coverage-v8": "^1",
    "drizzle-kit": "^0.20",
    "@biomejs/biome": "^1",
    "@types/node": "^22",
    "@types/ws": "^8"
  }
}
```

(versions to lock at scaffold time; checks via `npm view <pkg> version`.)

---

## 8. Week-1 deliverables (concrete checklist)

In order. Each is a separate commit minimum.

**Day 1-2 — Repository scaffold**
- [ ] Init repo, `git init`, push to GitHub `ora-et-labora-v2`
- [ ] `package.json`, `tsconfig.json` (strict), `biome.json`
- [ ] `CLAUDE.md` (use template above)
- [ ] `.env.example`, `.gitignore`
- [ ] Copy planning docs from v1 repo `docs/v2/` and `docs/rewrite/` into new repo `docs/`
- [ ] Initial folder structure (empty src/ subdirs, README placeholder in each)

**Day 2-3 — DB + types foundation**
- [ ] Postgres local via docker-compose
- [ ] `drizzle.config.ts`
- [ ] Schemas in `src/db/schema.ts` for: users, wallets, strategies, whales, markets, signals, positions, orders, fills, marks, lifecycle_events, strategy_filters, kill_switches (all with `user_id BIGINT NOT NULL DEFAULT 1`)
- [ ] Initial migration via `drizzle-kit push`
- [ ] Seed script: row id=1 in users, row id=1 in wallets (env-driven), default strategy "sports_whale_follow_v1", initial whales (sports addresses from v1 config)
- [ ] Type definitions in `src/types/` from SPEC.md (ExitAction, ExitIntent, ExitConfig, PositionView, MarketSnapshot, Strategy)

**Day 3-4 — `decide_exit` pure function (TDD)**
- [ ] Failing tests for all 10 V2 invariants (M1-M5, D1-D3, O1-O2) in `tests/invariants/`
- [ ] Failing tests for top 10 QA patterns from TESTS.md (QA-180, QA-181, QA-166, QA-165, QA-156, QA-155, QA-154, QA-149, QA-160, QA-144) in `tests/qa_patterns/`
- [ ] Property tests via fast-check on outcome floor and dead orderbook detection
- [ ] Implement `decide.ts` to make tests green
- [ ] 95%+ coverage gate enforced

**Day 4-5 — Spike deliverables (research)**
- [ ] **Filter audit (2h):** read v1 `core/filters/` + last 30d log data; produce Markdown table `filter_name | last_fired_at | fire_count_30d | port_or_cut`. Output → `docs/v2/filter_audit.md`. Goal: identify ~17 living filters.
- [ ] **Builder rewards spike (2h):** read Polymarket builder docs; estimate $/month at 50/100/200 trades-per-week volume. Output → `docs/v2/builder_rewards_estimate.md`.
- [ ] **Competitive analysis brief (1d):** Polycop + 2 others; UX/pricing/feature compare. Output → `docs/v2/competitive_brief.md`.

**Day 5-7 — Observability + executor skeleton**
- [ ] OTEL collector + Prometheus + Loki + Grafana — docker-compose initially, systemd later
- [ ] OTEL tracer wrapper in `src/obs/tracer.ts`
- [ ] First metrics: `whale_to_buy_latency_ms`, `decide_exit_duration_ms`, `position_monitor_tick_ms` histograms
- [ ] First Grafana dashboard: solo bot operational view
- [ ] `OrderManager` with FOK BUY signing (clob-client-v2 + viem) — DRY mode only initially
- [ ] `FillReconciler` reading User WS

By end of week 1: scaffold + DB + decide_exit + observability stack + 3 spikes done. Ready for P1 weeks 2-3 to put it all together into a runnable solo bot.

---

## 9. Critical hand-off facts (don't miss)

1. **CLOB V2 launched April 28, 2026.** No backward compat. Use `@polymarket/clob-client-v2` v1.0.2 + viem. v1 SDKs throw `order_version_mismatch`. See `clob-v2-research.html`.

2. **Order struct V2:** `salt`, `nonce`, `feeRateBps`, `taker` are GONE. `timestamp`, `metadata`, `builder` are ADDED. Fees in USDC at match-time, not in shares at placement. See `POLYMARKET_API.md` → "Signed order payload — V2".

3. **Collateral is pUSD, not USDC.** 1:1 USDC-backed ERC-20. Convert on deposit.

4. **`decide_exit` is a pure function.** No I/O. No DB session. No globals. ExitExecutor mutates state. This kills v1's Invariant 23 + 27 (architecturally impossible now).

5. **Source of truth (INV-D1):** `/positions` for positions, `/activity` for realized PnL, `gamma.outcomePrices` for odds, `/book` for bid/ask. NEVER `/midpoint`. NEVER synthesized `mark*0.99`.

6. **Reconciliation has grace periods (INV-D3):** 30s for PENDING/FILLED states (eventual consistency window), 60s for EXITING. After grace: drift 0-5% sync, 5-10% freeze with WARN, >10% freeze with P0. See architecture.html section 08 for full pseudocode.

7. **Builder rewards register Day 1.** Even if uncertain about $/month — populate `builder` field on every order. Free side-revenue.

8. **Sports-only in P1.** Cut crypto whale tracking. Crypto strategies return P4+.

9. **Schema is multi-user-shaped from Day 1** but only one user exists until P3c. `user_id BIGINT NOT NULL DEFAULT 1` everywhere. Migration to multi-user is adding rows in `users`/`wallets`, not schema changes to existing tables.

10. **Geo-block US** until lawyer review. CFTC precedent on Polymarket itself ($1.4M fine).

11. **No code outside docs until repo is ready.** This package contains design only. Claude Code will scaffold per week-1 deliverables.

---

## 10. Open questions to ask Taras before week-1 starts

| # | Question |
|---|---------|
| Q1 | Repo name confirmed `ora-et-labora-v2`? GitHub org/account? |
| Q2 | Are v1 sports whale addresses available to seed week-1 DB? |
| Q3 | Which Telegram chat ID for P2 whitelist? |
| Q4 | Does Taras have Hetzner SSH ready for OTEL stack deploy? |
| Q5 | Existing Polymarket API creds (key/secret/passphrase) — reuse or generate fresh for v2? |
| Q6 | Builder address — register fresh or reuse existing? |
| Q7 | Any specific filters Taras wants priority-ported regardless of audit findings? |
| Q8 | Initial DRY budget allocation — match v1's, or different for v2 testing? |

---

**This doc is the contract.** If something contradicts the planning files, the planning files are authoritative. If something is missing here, check architecture.html section 14-18 first.
