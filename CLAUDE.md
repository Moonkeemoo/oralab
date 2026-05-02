# CLAUDE.md — Ora et Labora v2

> Sports-focused Polymarket auto-trading bot. TypeScript native. CLOB V2.
> Two north stars: "least problems in LIVE, nothing gets stuck" + "alpha capture begins week 4, not week 8".
> Repo: `Moonkeemoo/oralab` (short alias for `ora-et-labora-v2`).

## What this project does

Listens to whale wallets via on-chain events + WebSocket; copies entries through filter pipeline; manages exits via `decide_exit` pure function; closes only on confirmed on-chain SELL fill or market resolution.

P1 = solo bot, sports-only, single user (Taras). P1.5 = SportsScoreReactor for alpha capture. P2 = Telegram Mini App + bot. P3c (week 11+) = multi-user with BYO non-custodial smart wallets (ERC-1271).

## Architecture (one screen)

```
External:        Polymarket WS · Polygon RPC · CLOB V2/Gamma/Data REST · Sports WS · Telegram
Hetzner svcs:    ora2-feed → ora2-trader → ora2-api → ora2-bot · ora2-watchdog · OTEL stack
DB:              PostgreSQL 16 (single source of truth)
Frontend:        Mini App on Cloudflare Pages (oralab.xyz/app, served via existing Caddy)
```

Full design: `docs/architecture.html`. Constitution: `docs/SPEC.md`. API: `docs/POLYMARKET_API.md`.

## Critical rules — top 7 (full list in SPEC.md)

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

- **TypeScript strict** — no `any`, no implicit any, no unchecked indexes
- **Discriminated unions** for status — never string status
- **Pure functions where possible** — `decide_exit` MUST be pure
- **Postgres + drizzle** — never JSON files for state
- **vitest + fast-check** — coverage 95%+ on `src/decide.ts`
- **viem** for chain — typed events, modern patterns
- **Platform UI in English; Claude ↔ Taras collaboration in Ukrainian**
- **No bridge sidecar** — TS calls `@polymarket/clob-client-v2` directly
- **No builder rewards** — Polymarket Builder Program registration unavailable to us; do NOT include `builder` field in order payload, do NOT add `POLY_BUILDER_ADDRESS` env var

## Kickoff decisions (locked 2026-05-02)

| Topic | Decision |
|---|---|
| GitHub repo | `Moonkeemoo/oralab` (private). v1 archived at `Moonkeemoo/ora-et-labora`. |
| Hetzner | Single shared box `ora@204.168.239.121` (CPX22 Helsinki, Ubuntu 24.04). v1 frozen at `/opt/_archived_v1/ora-et-labora-snapshot-2026-05-02`. |
| POLY API creds | Reuse v1's. `POLY_WALLET_ADDRESS=0xba462127...`. |
| Builder rewards | DROPPED — not available to us. No `POLY_BUILDER_ADDRESS`. No `builder` field on orders. |
| SL / TP / Trail | PORT v1 verbatim: SL=-15%, SL_emergency=-17%, TP=+20%, trail_activate=+15%, trail_stop=-5%, ceiling_tp_price=0.97, min_sl_age_s=300. (SPEC §08 numbers do NOT apply.) |
| DRY budget | $100, base_usd=$75, max_entry_shares=10, trader_allocation=1.0 (match v1 for P3a apples-to-apples replay). |
| Whales | Seed from `oralab-v1-archive-2026-05-02.tar.gz` `output/wallet_profiles.json`, filter by `sports_domains.length > 0`. |
| Filters | Port v1 `core/filters/hard_safety.py` unconditionally; rest via week-1 audit using `output/decision_log.jsonl` from archive. |
| P3a (week 7) | "Parallel run vs v1 LIVE" replaced with shadow-replay against v1 captured logs (since v1 archived, not running). |

## Phase plan (one screen)

| Phase | Weeks | What |
|---|---|---|
| Spike | 1 | scaffold + observability + 2 spikes (filter audit, competitive — no builder spike) |
| P1 | 2-3 | solo bot foundation, sports-only, all DRY |
| P1.5 | 4 | SportsScoreReactor minimum (alpha capture starts) |
| P2a | 5 | Mini App + bot |
| P2b | 6 | decision log capture |
| P3a | 7 | DRY shadow-replay vs v1 archive — 7 days hard gate |
| P3b | 8 | LIVE migration solo |
| Wks 9-10 | — | solo LIVE stability + pricing waitlist |
| P3c | 11-12 | multi-user closed beta |
| P3d | 13-14 | open beta |
| P4+ | mo 4+ | full sports + crypto + calibrator + monetization |

## Running

```bash
npm install
docker-compose up -d postgres        # or local postgres
cp .env.example .env                 # fill in secrets from v1 .env
npm run db:push                      # apply schema
npm run dev:trader                   # ora2-trader (DRY)
npm run dev:feed                     # ora2-feed
npm run dev:watchdog                 # ora2-watchdog
npm test                             # full vitest suite
npm run test:coverage                # coverage report
npm run typecheck                    # tsc --noEmit
npm run lint                         # biome check
```

## Tooling

### Skills (used reflexively)
- `brainstorming` → `writing-plans` → `executing-plans` — for new features only
- `test-driven-development` — always for `src/decide.ts` changes
- `systematic-debugging` — when bugs appear
- `verification-before-completion` — before claiming any task done

### Static checks
- `npm run typecheck` (strict)
- `npm run lint` (biome)
- `npm test` with coverage threshold

## Maintenance triggers

Update this file when:
- New top-level directory added
- New invariant discovered (also update `docs/SPEC.md`)
- New agent or MCP tool added
- Convention change

Skip for: bugfixes, tests, dashboard UI tweaks.
