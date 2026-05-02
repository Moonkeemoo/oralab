# Claude Setup — How to Configure the AI Collaborator for the Rewrite

This document configures Claude's behavior on day 1 of the new project,
distilled from 4 months of collaboration patterns. Without this, every
new session re-learns the same lessons by losing money.

Three pieces:
1. **Project CLAUDE.md** — auto-loaded every session; orientation map
2. **Memory seeds** — persistent across sessions; user/feedback/project/reference
3. **Agents + hooks** — automation patterns

---

## 1. Project CLAUDE.md template

Save as `CLAUDE.md` at repo root of the new project.

```markdown
# CLAUDE.md — <PROJECT_NAME>

> Whale-signal copy-trader on Polymarket. TypeScript native, no Python.

## What this project does

Polymarket trading platform. Listens to whale wallets via on-chain events + WebSocket; copies entries through filter pipeline; manages exits via decide_exit pure function; closes only on confirmed on-chain SELL fill or market resolution.

**Phasing:** P1 solo bot (single user = Taras, env-driven wallet). P2 Mini App + bot + Calibrator port. P3 multi-user platform (BYO smart-wallet via ERC-1271, OR custodial encrypted-PK; per-user isolation). P4+ new alpha (sports WS reactor, pre-event EV).

Schema is multi-user-shaped from P1 (every state table has `user_id` with default 1). Migration from solo to multi-user is adding `users`/`wallets` rows + auth, not rewriting tables.

## Architecture

\`\`\`
src/
├── types.ts            # ExitIntent, Position, MarketSnapshot, ExitConfig
├── decide.ts           # decide_exit pure function — single source of exit truth
├── executor.ts         # Wraps @polymarket/clob-client-v2; bridge-free
├── chain.ts            # viem-based whale signal detection + own-fill listener
├── filters/            # 8-phase pipeline (port from V1)
├── api/                # Polymarket APIs (CLOB, Data, Gamma) clients
├── state.ts            # better-sqlite3 persistence
├── reconciler.ts       # /positions diff every tick (INV-D3)
├── watchdog.ts         # rule registry + journal
└── server.ts           # dashboard HTTP + WS

tests/
├── decide.spec.ts      # 100% branch + property + replay
├── executor.spec.ts    # mocked SDK
└── replay/             # 30 QA patterns from docs/rewrite/TESTS.md
\`\`\`

## Critical rules (from docs/rewrite/SPEC.md)

| # | Rule | If violated |
|---|------|------------|
| INV-M1 | Never sell more than on-chain shares | order rejection / oversell |
| INV-M2 | Never sell below outcome floor | dump value at dust prices |
| INV-M3 | Closure only via chain SELL filled OR resolved | orphan position |
| INV-D1 | Source-of-truth hierarchy | wrong PnL display |
| INV-D2 | Mark staleness gate before SL/TP | false SL on stale data |
| INV-D3 | Continuous /positions reconciliation | drift accumulates |
| INV-O2 | Bounded ops: timeout + retry + idempotent | bot stuck |

Full list: \`docs/rewrite/SPEC.md\`. API surface: \`docs/rewrite/POLYMARKET_API.md\`.
Test patterns: \`docs/rewrite/TESTS.md\`.

## Conventions

- **TypeScript strict** — no any, no implicit any, no unchecked indexes
- **Discriminated unions** for status — never string status
- **Pure functions where possible** — decide_exit MUST be pure
- **vitest + fast-check** for tests; coverage target 95%+ on decide.ts
- **better-sqlite3** for state — never JSON files
- **viem** for chain — typed events, modern patterns
- **Platform UI (Mini App) and platform-facing copy: English-only.** No i18n, no locale files. Multi-user means international users.
- **Claude ↔ Taras collaboration: Ukrainian.** Memory, chat, internal review comments. Two different audiences.
- **No bridge sidecar** — TS calls @polymarket/clob-client-v2 directly

## Running

\`\`\`bash
bun install                  # or pnpm
bun run dev                  # trader + watchdog + dashboard
bun test                     # full suite
bun test --coverage          # coverage report
\`\`\`

## Critical invariants (top 5)

> Full text: docs/rewrite/SPEC.md

1. **decide_exit is pure** — no I/O, no side effects, deterministic
2. **closure_reason only after chain SELL fill** (INV-M3 / QA-181)
3. **Real bid/ask from /book, never synthesized** (INV-D2 / QA-180)
4. **Pre-flight balance check before every order** (INV-M1)
5. **Mark age + spread gate** before SL/TP fires (INV-D2)

## Tooling

### Agents
- **product-qa** — bug pattern recorder (LEARN mode on commits to src/)
- **trader-watchdog** — read-only journal tail + ops alerts
- **trader-analyst** — daily PnL report (read-only)

### Skills
- brainstorming → writing-plans → executing-plans — for new features
- test-driven-development — always for decide.ts changes
- systematic-debugging — when bugs appear
- code-review — before merging V2 paths

### Static checks
- TypeScript compiler (strict)
- vitest with --coverage
- biome lint + format

## Maintenance triggers

Update this file when:
- New top-level directory added
- Architecture changes (new core module)
- New invariant discovered (also update SPEC.md)
- New agent or MCP tool added
- Convention change (lint, test runner, etc.)

Skip for: bugfixes, tests, dashboard UI tweaks.
```

---

## 2. Memory seeds

Memory files persist across Claude sessions. Pre-seed these in
`~/.claude/projects/<project-path>/memory/` to avoid re-learning.

### MEMORY.md (index)

Start with this content:

```markdown
- [User non-coder PO](user_non_coder.md) — explain in outcomes/risks; user decides scope, I decide architecture
- [Never deploy without ask](feedback_never_deploy.md) — never push/merge/promote without explicit "deploy" / "ship" instruction
- [Autonomous shift = fix=deploy](feedback_autonomous_shift.md) — overrides above when user hands off "стежи/фікс" shift
- [PnL plain magnitudes](feedback_pnl_style.md) — write "збиток $X / прибуток $Y", never "Δ −$X"
- [Verify on-chain before any claim](feedback_verify_onchain.md) — every PnL/balance/closure claim cross-check /positions or /activity
- [Tick reporting threshold](feedback_tick_threshold.md) — silent unless ±5% PnL, alerts, opens/closes, state transitions
- [Idle cadence cap 5min](feedback_idle_cap.md) — max 5min sleep when 0 open positions; re-read state before "0 open" report
- [Critical react immediately](feedback_critical_react.md) — stuck SL / live drawdown = drop heartbeat, ship fix <10min
- [No plans for small fixes](feedback_no_plans_small.md) — skip writing-plans for bug fixes; reserve for new features
- [Subagent-driven default](feedback_subagent_default.md) — always run subagents in background, don't ask
- [Source-of-truth hierarchy](feedback_truth_hierarchy.md) — /positions = chain truth, /activity = realized PnL truth, gamma = market state, clob /book = bid/ask
- [Never trust /midpoint endpoint](feedback_midpoint_stale.md) — synthesizes from old trades, not real bid/ask (QA-180)
- [Never set closure_reason without chain SELL fill](feedback_closure_reason_gate.md) — INV-M3 / QA-181
- [Never synthesize bid/ask from mark](feedback_no_synthetic_book.md) — fetch /book directly; spread gate is theater otherwise
- [Polymarket env vars](reference_poly_env.md) — POLY_PRIVATE_KEY, POLY_WALLET_ADDRESS (proxy), POLY_API_KEY/SECRET/PASSPHRASE
- [outcomePrices is JSON-encoded string](reference_gamma_quirks.md) — JSON.parse(market.outcomePrices); negRisk explicit; data-api needs Mozilla UA
- [Tick alignment epsilon](feedback_tick_epsilon.md) — Math.floor(price/tick + 1e-9) for SELL; floats give 44.99999 from 0.045/0.001
- [Project budget target](project_budget_target.md) — wallet $X → $Y by date; drives sizing/conviction; current wallet 0xba462127...
```

### Critical individual files

**`feedback_pnl_style.md`:**
```markdown
---
name: PnL plain magnitudes
description: Use plain "збиток $X / прибуток $Y" magnitudes, never signed deltas like "Δ −$X"
type: feedback
---

When reporting PnL: "збиток $1.66" or "прибуток $0.41". Never "Δ −$1.66" or "−$1.66 (−38%)".

**Why:** signed delta with minus sign reads ambiguously to non-coder PO ("did we lose?"). Plain language unambiguous.

**How to apply:** every PnL line in chat output, telegram, daily reports. Sign-prefix only in raw debug logs, not user-facing.
```

**`feedback_verify_onchain.md`:**
```markdown
---
name: Verify on-chain before any claim
description: Every PnL/balance/position/closure claim must be cross-checked against Polymarket /positions or /activity before reporting; trades.json is local cache, not truth
type: feedback
---

Before stating any of these as fact: realized PnL, position open/closed, share counts, cost basis, "trade was sold/filled":
- Curl /positions for "what we own now"
- Curl /activity for "what filled on chain"
- Cross-check vs local DB

If divergence detected: report "verified vs /positions: N shares, value $X" or "local-only — not yet verified on-chain".

**Why:** Local state lies. trades.json showed status="open" while chain had BUY+SELL pair (Brentford incident). Bot's mark $0.328 vs chain curPrice $0.405 (Nongshim). Always cross-check.

**How to apply:** every monitoring tick starts with /positions + /activity diff vs local. Never report PnL or position state without saying which source.
```

**`feedback_critical_react.md`:**
```markdown
---
name: Critical react immediately
description: Stuck SL / unreachable retries / live drawdown = drop heartbeat, ship fix <10min; don't ask permission when bot is bleeding
type: feedback
---

When live position is bleeding due to bot bug (stuck SL, unreachable retries, dead orderbook with no fallback): drop the routine, fix and deploy in <10 minutes. Don't ask "do you want me to ship?" — just ship.

**Why:** asking permission while bot bleeds costs more than any deploy mistake. User loss > my caution. Stuck SL on Nongshim cost user $1.66 because I asked instead of acted.

**How to apply:**
1. Identify root cause within 2 min
2. Patch + push within 5 min
3. Tell user post-factum: "fixed X, deployed v0.X.Y, here's why"
4. Only escalate to user if fix requires architectural decision >30min work

Override: when user explicitly says "stop" — full stop, no autonomous action.
```

**`feedback_no_synthetic_book.md`:**
```markdown
---
name: Never synthesize bid/ask from mark
description: Always fetch real bid/ask from /book; never default to mark*0.99/mark*1.01; INV-D2 spread gate is theater on synthetic data (QA-180)
type: feedback
---

Any path that needs bid/ask MUST query clob.polymarket.com/book directly (with TTL cache 3-5s). NEVER default to mark*0.99 or similar synthesis when bid/ask absent.

**Why:** dead orderbooks (real bid $0.01 / ask $0.99 = 196% spread) are the exact case INV-D2 spread gate exists to catch. Synthesizing bid/ask gives uniform 2% spread that always passes the gate. Result: V2 fires SL on stale midpoint when book is dead. Money loss.

**How to apply:** in TS, no `bid ?? mark * 0.99` patterns. If real bid/ask unavailable, return HOLD — staleness, not optimism.
```

### Project memory

**`project_budget_target.md`:**
```markdown
---
name: Project budget target
description: Wallet started at $X targeting $Y by date Z; drives sizing/conviction tuning
type: project
---

Wallet 0xba462127e57124acf907f00f87543805d9e7ae62 (proxy/funder).
Current state at rewrite: ~$108 (after V1 session losses).
Target: $200 by 2026-05-10 → $400 → $800 (multi-stage growth plan).

**Why:** sizing decisions (BASE_BET_PERCENT, MAX_ENTRY_SHARES, MAX_OPEN_POSITIONS) all derive from this target. Conviction thresholds tuned to allow enough fast-pass entries to hit timeline.

**How to apply:** when tuning sizing or filter thresholds, anchor against target growth rate. Update target as wallet grows through stages.
```

---

## 3. Agents + hooks

### Agent definitions

Place in `.claude/agents/` of new project.

**`.claude/agents/product-qa.md`:**
```markdown
---
name: product-qa
description: Behavioral bug detector. SCAN runtime data for anomalies. LEARN records new patterns from incidents. Triggers AUTO-LEARN on commits to src/.
tools: Read, Grep, Glob, Bash, Write, Edit
---

You are the QA bug-pattern keeper for the Polymarket whale-signal bot.

## Modes

### SCAN (default when called manually)
Walk runtime data (trades.db, watchdog journal) checking for known patterns from docs/qa/patterns/. Report violations with severity P0/P1/P2.

### LEARN (called by AUTO-LEARN hook)
On commit message hint, record the new bug pattern in docs/qa/patterns/qaXXX_*.md. Continue numbering from highest existing.

## Knowledge base
docs/qa/patterns/ — every file = one bug pattern + detector + reproduce steps.
docs/qa/MEMORY.md — index by category.
```

**`.claude/agents/trader-watchdog.md`:**
```markdown
---
name: trader-watchdog
description: Read-only tail of prod ora-watchdog journal. Surfaces P0/P1 alerts to parent Claude. Never writes; never executes orders.
tools: Bash, Read, Grep
---

Tail prod watchdog journal continuously. Report alerts in Ukrainian to parent.
Connection: ssh ora@<host>.
Source: sudo journalctl -u ora-watchdog --since "30 seconds ago" --no-pager.

Escalate P0 immediately. Sleep 30s between checks if quiet.
```

### Hooks

**`.claude/hooks/post-commit.sh`:**
```bash
#!/bin/bash
# AUTO-LEARN trigger: any commit touching src/ spawns product-qa LEARN mode
COMMIT_HASH=$(git rev-parse --short HEAD)
COMMIT_MSG=$(git log -1 --pretty=%s)
CHANGED=$(git diff-tree --no-commit-id --name-only -r HEAD)

if echo "$CHANGED" | grep -qE "^src/"; then
  echo "AUTO-LEARN: commit $COMMIT_HASH touched src/. Run product-qa agent in LEARN mode (background)."
fi
```

Register in `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse:Bash": ".claude/hooks/post-commit.sh"
  }
}
```

---

## 4. Skills usage decision tree

```
User message arrives
├─ "build/add/refactor X" → brainstorming → writing-plans → executing-plans
├─ "fix bug Y" → systematic-debugging skill, then direct edit (no plan)
├─ "check/scan/audit" → product-qa SCAN
├─ "deploy/ship" → only with explicit user instruction (autonomous shift override)
├─ "monitor live" → trader-watchdog subagent in background
└─ "tell me about X" → direct answer; no skill needed
```

---

## 5. Workflow patterns to internalize

### On any new feature
1. Brainstorming skill (clarify scope, edge cases)
2. Writing-plans skill (create plan file)
3. Code review against SPEC.md invariants
4. Test-driven: write red tests from TESTS.md FIRST
5. Implement to green
6. Verification-before-completion skill
7. Commit + push

### On bug investigation
1. Systematic-debugging skill (formalize hypothesis)
2. Reproduce with test case
3. Cross-check against /positions + /activity (verify_onchain feedback)
4. Patch + replay tests
5. Add new test case to TESTS.md if novel
6. Commit triggers AUTO-LEARN if bug pattern unique

### On live monitoring
1. trader-watchdog in background
2. /positions + /activity every tick
3. Tick reporting threshold: ±5% PnL crossing
4. Idle cadence cap: 5min when no opens
5. Critical-react: stuck SL = ship fix in <10min, don't ask

---

## 6. What NOT to put in memory

- Code patterns / conventions / file paths (derivable from code)
- Git history (use `git log`)
- Debug recipes (in code + git blame)
- Anything in CLAUDE.md
- Ephemeral task state

These persist in `MEMORY.md` index but content lives in source.

---

## 7. First-session startup checklist

When Claude starts a session in the new project:

1. Auto-loads CLAUDE.md (orientation map)
2. Auto-loads MEMORY.md index (cross-session memory)
3. Reads docs/rewrite/SPEC.md when touching any decide_exit logic
4. Reads docs/rewrite/POLYMARKET_API.md when touching API client code
5. Reads docs/rewrite/TESTS.md when writing/changing tests
6. Spawns trader-watchdog in background if user says "monitor"
7. Verifies on-chain state before reporting any PnL claim
8. Uses skills (brainstorming/plans/TDD) per workflow patterns above

This ensures every session is consistent regardless of model version
or context length. The configuration is the constitution.
```
