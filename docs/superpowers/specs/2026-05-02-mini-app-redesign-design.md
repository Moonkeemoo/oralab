# Mini App redesign — design doc

> Date: 2026-05-02
> Status: approved (Taras 2026-05-02 "та роби, довіряю тобі")
> Author: Claude (UX synthesis based on Taras input + v1 calibrator memory)
> Replaces: ad-hoc 3-card MVP shipped in commit `65613b2`

## Context

Taras (PO + solo operator + auto-trading veteran) needs to monitor and
control ora2 from his phone via @Oralab_bot Mini App. The week-1 MVP
(3 cards: Status / P&L / Positions plus Pause/Resume) was a smoke-grade
proof — it answered "is the bot alive?" but not the operator-grade
questions a trading PO asks daily.

This document specifies the redesigned Mini App: information architecture,
screens, drilldowns, and the explicit boundary between what ships now (MVP)
and what's deferred to later phases.

The literal CLAUDE.md phase plan places Mini App at **P2a (week 5)** and
"full sports + crypto + calibrator + monetization" at **P4+ (month 4+)**.
This redesign keeps Mini App MVP at P2a; calibrator UI and full whale
P&L attribution stay deferred per that plan.

## Users and jobs-to-be-done

Single primary user: Taras. Five recurring jobs:

1. **Morning glance** — overnight P&L, win rate, drawdown, bot alive?
2. **Continuous monitoring** — what is the bot doing right now? Open
   positions, latest signals, current decisions, latency, errors.
3. **Reaction** — bot did something surprising → drill into the specific
   trade → understand WHY (gates fired, snapshot at decision time, fills).
4. **Tuning** — adjust SL/TP/trail/budget/conviction; toggle filters;
   mute underperforming whales.
5. **Risk** — fast kill switch, exit-all, freeze a single position.

Anti-goal: this is **not** a Bloomberg-density desktop terminal. Single
operator, mobile-first, one-handed where possible.

## Information architecture

```
┌─────────────────────────────────────────┐
│ COCKPIT BAR  (sticky, always visible)   │
│  mode • kill • $today • active • health │
├─────────────────────────────────────────┤
│                                         │
│           ACTIVE TAB CONTENT            │
│           (vertical scroll)             │
│                                         │
├─────────────────────────────────────────┤
│ 📊 Live │ 📜 History │ ⚙ Strategy │     │
│           │ 🐋 Whales │ ☰ More          │
└─────────────────────────────────────────┘
```

### Cockpit bar (sticky)

Five chips, single line:

- **mode**: `DRY` (green) / `LIVE` (red)
- **kill**: `KILL OFF` (green) / `KILL ON` (red)
- **today P&L**: signed, color-coded ($+1.84 green, $-0.40 red)
- **active**: `N positions` (link to Live tab)
- **health dot**: green / yellow / red — aggregate of WS+DB+latency

Tap any chip → relevant detail. Tap health dot → More tab connections card.

### Bottom tabs

| Icon | Tab | Default? |
|---|---|---|
| 📊 | Live | ✅ |
| 📜 | History | |
| ⚙ | Strategy | |
| 🐋 | Whales | |
| ☰ | More | |

## Screens

### Tab 1 — Live (default)

Three cards, top-to-bottom:

**Now happening** — heartbeat strip. One line each:

- last whale signal received `Xs ago`
- last decide_exit tick `Xs ago`
- pending entries: `0`
- decisions/sec (last 60s): `X`

If any value crosses red (e.g. >300s no signal during peak hours), card
shows yellow border + "stale?" hint.

**Active positions** — list of cards (1 card per position):

```
┌──────────────────────────────────────┐
│ #14  OPEN  ▶                         │
│ 10.500 sh @ 0.34  →  mark 0.36       │
│ pnl +5.8% ($0.21)   age 12m  sweep 0 │
└──────────────────────────────────────┘
```

Tap → bottom sheet drilldown (see below).

**Recent rejects** — last 100 signals breakdown by reject reason. Single
horizontal scrollable strip:

```
87 sport_only  •  9 price_too_high  •  3 budget  •  1 stale
```

Action row pinned at bottom of screen:

`[Pause]  [Resume]  [Exit All]` — with confirmation dialog for Exit All.

#### Position drilldown (bottom sheet)

Opens on tap of any position row. Sections:

1. **Header**: id, status pill, market title, time-in-position
2. **Key numbers**: entry, peak, mark, pnl%, sweep_count, fillTs
3. **Timeline** (vertical): signal → BUY (with fill price) → decide_exit
   ticks (sampled, last 10) → SELL attempts → CLOSED with close_reason.
   Each step shows ts + relative time.
4. **Gates fired**: list of decide_exit gate-tags ever observed for this
   position (e.g. `SL`, `TP`, `TRAIL`, `INV-M2`)
5. **Raw payloads** (collapsible): signal JSON, BUY response, last SELL
   response, close event
6. **Actions**: `Exit Now` (POST /api/positions/:id/exit) and `Freeze`
   (POST /api/positions/:id/freeze) — both gated by confirmation dialog.
   `Exit Now` body: `{mode: "GTD" | "FOK" | "FAK", slippagePct?: number}`,
   default `FAK` with 20% slippage (matches scripts/exit-all-positions.ts).
   `Freeze` writes `status=FROZEN`, `closeReason='manual_freeze'`, plus
   audit_log row.

### Tab 2 — History

Top filter row (3 chips, multi-select):

- date range: `today / 24h / 7d / 30d / custom`
- strategy: `all / whale_follow_v1 / ...`
- outcome: `all / wins / losses`

**Aggregates card** (responds to filters):

```
trades 24  •  win 14 (58%)  •  net +$1.84  •  avg +$0.08
best  +$0.62  •  worst -$0.45
```

**Cumulative P&L sparkline** under aggregates (read-only, first delivery
is a Canvas-rendered line; D3/recharts not pulled in MVP).

**Trade rows** — virtual-scroll list:

```
#12  ✓ +$0.16  TP    Lakers v Celtics  2h ago
#11  ✗ -$0.40  SL    NBA spread       3h ago
```

Tap → same drilldown sheet as Live tab.

### Tab 3 — Strategy

Three sub-cards in a vertical scroll:

**a) Strategy params** (per strategy, MVP shows whale_follow_v1 only):

```
whale_follow_v1                         [enabled ⊙]
─────────────────────────────────────────
budget                $5     [edit]
baseSizeUsd           $3     [edit]
maxEntryShares        10     [edit]
defaultConviction     1.0    [edit]
exitReentryCooldown   225s   [edit]
```

Each `[edit]` opens an inline numeric input with bounds (`baseSizeUsd > 0`,
`budget > 0`, `maxEntryShares ∈ [1, 10000]`, `defaultConviction ∈ [0,1]`).
Server validates against a per-key schema in `src/api/strategy_schema.ts`
(new file) before persist. Save → POST /api/strategies/:id/params →
DB UPDATE on `strategies.params` JSONB → `WhaleFollowStrategy` re-reads
on each `evaluate()` call (already does — see `readParams` in
`src/strategies/whale_follow.ts`), so changes take effect on next signal
without restart.

**b) Exit config** (global per strategy, same edit pattern):

```
stopLoss        -15%   [edit]
stopLossEmerg   -17%   [edit]
takeProfit      +20%   [edit]
trailActivate   +15%   [edit]
trailStop       -5%    [edit]
ceilingTpPrice  0.97   [edit]
minStopLossAge  300s   [edit]
```

Banner above: "⚠ Changes apply to next decide_exit tick (≤500ms)".
Per-field bounds enforced server-side: `stopLoss ∈ [-0.99, 0]`,
`takeProfit ∈ [0, 1.0]`, `trailActivate ∈ [0, 1.0]`, `trailStop ∈ [0, 1.0]`,
`ceilingTpPrice ∈ (0, 1)`, `minStopLossAge ∈ [0, 86400]`.

**Live application**: PositionMonitor currently constructs `cfg` once at
startup from `DEFAULT_EXIT_CONFIG`. To make edits live without restart,
add `loadEffectiveExitConfig()` helper that merges
`DEFAULT_EXIT_CONFIG` with `runtime_config` rows (scope='global',
key prefix `exit.`) on every tick. Same 2s in-memory cache as
`isRuntimeKillSwitchActive()` so DB cost is bounded.

**c) Filters table** — read-only in MVP. One row per filter with:

| filter | seen | pass | reject% | bottleneck? |
|---|---|---|---|---|
| sport_only | 1240 | 142 | 88.5% | |
| price_too_high | 142 | 98 | 31.0% | |
| budget_exhausted | 98 | 42 | 57.1% | ⚡ |

Bottleneck marker `⚡` mirrors v1 calibrator semantics: any filter
responsible for ≥30% of rejections in the last 24h. Tap row → empty
"24h chart coming in P2c calibrator wave" placeholder.

### Tab 4 — Whales

Top filter chip: `tracked / all / by-perf`.

Whale list: address (shortened), classification, total trades observed,
P&L attributed (only if `tracked=true` and we have closed trades on their
signals). Each row tappable → bottom sheet:

- All signals from this whale (paginated)
- Hit rate (signals → entries)
- P&L breakdown
- Toggle: `tracked` ↔ `untracked` (POST /api/whales/:address/track)

⚠ Full P&L attribution requires the `attribution` table from v1 which we
don't yet have in v2. P2a MVP will show classification + signal count and
"P&L coming in P2c". Toggle still ships — operator can mute a noisy
whale immediately.

### Tab 5 — More

Five sub-cards:

1. **Notifications** (read-only in MVP listing what's wired): BUY filled,
   Position closed, Position frozen, Fatal error. Toggle UI deferred to P2d.
2. **Connections health**: Polygon RPC, RTDS WS, Sports WS, CLOB user WS,
   gamma. Each row: last successful ping/event ts + "connected/error".
3. **Performance metrics**: decide_exit p99 ms, position_monitor tick p99
   ms, WS reconnects (24h).
4. **Audit log**: last 50 events from `audit_log` (NEW TABLE — see schema
   section below). Includes kill_switches toggled, params changed,
   calibrator actions, manual exits.
5. **Build info**: git commit short hash, service start ts, version.

## Data sources / new endpoints

Existing (from earlier P2a backend commit):

- `GET /api/health` (public)
- `GET /api/status`
- `GET /api/positions`
- `GET /api/pnl?windowHours=24`
- `POST /api/kill_switch`

New endpoints needed for MVP:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/positions/:id` | Single position with derived mark, pnl%, sweep count |
| GET | `/api/positions/:id/timeline` | Position timeline (signal+BUY+decide samples+SELL+close) |
| POST | `/api/positions/:id/exit` | Manual exit (places sell_bid_aggr or FOK) |
| POST | `/api/positions/:id/freeze` | Manual freeze (sets status=FROZEN, audit log row) |
| GET | `/api/history?windowHours=&strategy=&outcome=` | Closed positions w/ aggregates + sparkline data |
| GET | `/api/strategies` | List strategies w/ enabled flag + params |
| POST | `/api/strategies/:id/params` | Update params JSON (validated against schema) |
| POST | `/api/strategies/:id/enabled` | Toggle enabled |
| GET | `/api/exit_config` | Current exit config (env-overridable defaults) |
| POST | `/api/exit_config` | Update overrides (writes to a `runtime_config` row, decide_exit reads it) |
| GET | `/api/filters/stats?windowHours=24` | Per-filter seen/pass/reject counts |
| GET | `/api/whales` | Tracked whale list with classification + signal count |
| POST | `/api/whales/:address/track` | Toggle tracked |
| GET | `/api/connections` | Per-source last-event ts + state |
| GET | `/api/perf` | decide_exit / monitor / WS metrics from OTEL local cache |
| GET | `/api/audit?limit=50` | Last N audit log entries |
| GET | `/api/build` | Git commit + service start ts |

POST endpoints all require Telegram WebApp init-data auth (or
DEV_AUTH_TOKEN bypass during local dev).

## Schema additions

Two new tables:

**`runtime_config`** — overrides for env-driven defaults so operators can
tune without redeploy. Single global row in MVP; per-strategy in P3+.

```sql
CREATE TABLE runtime_config (
  id BIGSERIAL PRIMARY KEY,
  scope VARCHAR(16) NOT NULL DEFAULT 'global',
  key   VARCHAR(64) NOT NULL,        -- 'exit.stopLoss' / 'strategy.1.budgetUsd'
  value JSONB      NOT NULL,
  set_by_user_id BIGINT REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, key)
);
```

**`audit_log`** — every operator action and significant system event.

```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,                -- ms since epoch
  actor VARCHAR(32) NOT NULL,        -- 'mini_app' / 'bot' / 'reconciler' / 'calibrator'
  user_id BIGINT REFERENCES users(id),
  action VARCHAR(64) NOT NULL,       -- 'kill_switch_on' / 'param_change' / etc
  target VARCHAR(128),               -- pos id, strategy id, filter name
  payload JSONB NOT NULL DEFAULT '{}',
  CHECK (length(action) > 0)
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
```

Existing `kill_switches`, `decisions`, `signals`, `positions`, `fills`
tables already cover the rest.

## Auth / security

- Mini App is loaded inside Telegram client → server gets
  `X-Telegram-Init-Data` header → `validateInitData` (already implemented
  in commit `8c04525`) verifies HMAC and extracts userId.
- Local dev: `?dev=<DEV_AUTH_TOKEN>` query, forwarded as `X-Dev-Bypass`
  header.
- All POST endpoints require auth; unauthorized = 401.
- POST endpoints log every action to `audit_log` with actor='mini_app'
  + user_id from init-data.

## Out-of-MVP — added to global plan

Each defers to a named future phase. Captured here so they don't get lost.

| Item | Phase | Justification |
|---|---|---|
| Position drilldown timeline (full samples) | P2a-fe-2 | Requires `decisions` to accumulate + dense REST |
| Calibrator engine port (Python→TS) | P2c | Calibrator service runs nightly; port v1 logic |
| Calibrator UI (recent actions, pause, force-run, pending approvals) | P2c | Depends on engine port |
| Filter pass-rate history charts | P2c | Requires `filter_decisions` capture (per-signal log) |
| Editable filters (mute, threshold edit) | P2c | Per-filter validation UI |
| Whale P&L attribution | P2c | Requires `attribution` agg table |
| Notification config UI (per-event toggles + daily summary time) | P2d | Requires `notification_settings` table |
| Per-strategy P&L breakdown (multi-strategy era) | P3+ | Multi-strategy not active yet |
| Live latency / mini-charts | P3+ | OTEL aggregation pipeline |
| Mobile push (web push) | P4 | Native push beyond Telegram |

## Implementation phases (this design)

This spec drives **MVP frontend rewrite**. Implementation plan will split
into ordered chunks (writing-plans skill, next):

1. Backend endpoint expansion (list above) — extends `rest_server.ts`
2. Schema migrations (`runtime_config`, `audit_log`)
3. Frontend rewrite (web/) — replace 3-card SPA with 5-tab IA
4. Wire-in: cockpit bar polling + per-tab data loaders
5. Drilldown sheets (position, whale)
6. Edit flows (strategy params, exit config) with optimistic UI
7. Tests: rest_server expanded coverage, init-data auth on POSTs,
   audit_log writes
8. LIVE smoke from @Oralab_bot menu button

## Acceptance

Given the cloudflared tunnel + @Oralab_bot menu button setup, accept when:

1. Cockpit bar values match `psql positions / kill_switches` ground truth
2. Live tab "now happening" updates within 5s of new signal/decision
3. History 24h aggregates match `SELECT … FROM positions WHERE status='CLOSED'`
4. Edit a strategy param → next position uses new value (verify via
   decisions row inputSnapshot)
5. Edit exit config → next decide_exit tick uses new threshold
6. Pause from app → trader's next placeBuy returns kill_switch in ≤2s
7. Manual exit / freeze writes audit_log + transitions position
8. /pnl in @Oralab_bot still works (regression check on existing P2a)
9. Vitest green; tsc clean; biome check clean
