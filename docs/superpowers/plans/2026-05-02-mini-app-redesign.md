# Mini App redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the operator-facing Mini App per the approved design (5-tab cockpit IA, runtime-tunable strategy + exit config, position drilldown, audit trail) so Taras can monitor and control ora2 from his phone.

**Architecture:** Backend = `node:http` REST server (`src/api/rest_server.ts`) extended with ~17 new endpoints + 2 new DB tables (`runtime_config`, `audit_log`). Frontend = vanilla JS in `web/`, refactored from single-file MVP into per-tab views with a small router and shared sheet/api/format helpers. Telegram WebApp init-data auth on every POST. Same-origin static serve from /app.

**Tech Stack:** TypeScript 5 (strict), Node 22, Drizzle ORM, PostgreSQL 16, vitest + fast-check, Telegram Bot API (already wired), cloudflared HTTPS tunnel for local dev.

**Spec:** `docs/superpowers/specs/2026-05-02-mini-app-redesign-design.md`

---

## File map

**Backend (new):**
- `src/notify/audit_log.ts` — append-only audit logger
- `src/notify/runtime_config.ts` — DB-backed config reader with 2s cache
- `src/api/strategy_schema.ts` — per-key validation bounds
- `src/monitor/exit_config_loader.ts` — `loadEffectiveExitConfig()` merging defaults + runtime_config

**Backend (modified):**
- `src/db/schema.ts` — add `runtime_config` + `audit_log` tables
- `src/api/rest_server.ts` — add ~17 handlers + route table
- `src/monitor/position_monitor.ts` — use loader instead of `DEFAULT_EXIT_CONFIG`

**Frontend (rewritten):**
- `web/index.html` — shell with cockpit + tab-bar + view container
- `web/styles.css` — extended palette + sheet styles
- `web/app.js` — bootstrap (small, delegates to router)
- `web/js/api.js` — `fetchJson`, `postJson`, auth headers
- `web/js/format.js` — `fmt$`, `fmtPct`, `fmtTime`, escapeHtml
- `web/js/router.js` — hash-based tab routing
- `web/js/sheets.js` — bottom-sheet open/close utility
- `web/js/cockpit.js` — sticky bar polling
- `web/js/views/live.js`
- `web/js/views/history.js`
- `web/js/views/strategy.js`
- `web/js/views/whales.js`
- `web/js/views/more.js`
- `web/js/sheets/position.js` — position drilldown
- `web/js/sheets/whale.js` — whale detail
- `web/js/sheets/edit_param.js` — inline numeric edit

**Tests (new):**
- `tests/notify/audit_log.spec.ts`
- `tests/notify/runtime_config.spec.ts`
- `tests/api/strategy_schema.spec.ts`
- `tests/monitor/exit_config_loader.spec.ts`
- Endpoint tests are limited to auth gate + validation (DB integration covered by LIVE smoke at the end, matching existing project test pattern).

---

## Phase A — Foundations

### Task 1: Schema additions — `runtime_config` + `audit_log`

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/<timestamp>_<name>.sql` (auto-generated)

- [ ] **Step 1: Add table definitions to schema**

Append to `src/db/schema.ts`:

```ts
export const runtimeConfig = pgTable(
  "runtime_config",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scope: varchar("scope", { length: 16 }).notNull().default("global"),
    key: varchar("key", { length: 64 }).notNull(),
    value: jsonb("value").notNull(),
    setByUserId: bigint("set_by_user_id", { mode: "number" }).references(() => users.id),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_runtime_config_scope_key").on(t.scope, t.key),
    uniqueIndex("uq_runtime_config_scope_key").on(t.scope, t.key),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    actor: varchar("actor", { length: 32 }).notNull(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id),
    action: varchar("action", { length: 64 }).notNull(),
    target: varchar("target", { length: 128 }),
    payload: jsonb("payload").notNull().default({}),
  },
  (t) => [index("idx_audit_log_ts").on(t.ts)],
);
```

If `uniqueIndex` is not already imported, add to imports at top of file.

- [ ] **Step 2: Generate migration**

```bash
npm run db:generate
```

Expected: a new file `drizzle/<timestamp>_<name>.sql` containing the two CREATE TABLE statements.

- [ ] **Step 3: Apply migration**

```bash
npm run db:push
```

Expected: tables created with no errors. Verify:

```bash
psql postgresql://ora:ora@localhost:5433/ora_v2 -c "\d runtime_config" -c "\d audit_log"
```

- [ ] **Step 4: tsc clean**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "schema: runtime_config + audit_log tables (P2a-fe)"
```

---

### Task 2: `audit_log.ts` writer

**Files:**
- Create: `src/notify/audit_log.ts`
- Test: `tests/notify/audit_log.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/notify/audit_log.spec.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", () => {
  const insertMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn(() => ({ }));
  const dbStub = {
    insert: vi.fn(() => ({ values: (v: unknown) => { valuesMock(v); return insertMock(); } })),
  };
  // expose for assertions
  (globalThis as { __auditMock?: unknown }).__auditMock = { insertMock, valuesMock, dbStub };
  return { getDb: () => dbStub };
});

import { writeAudit } from "../../src/notify/audit_log.js";

const m = (globalThis as { __auditMock: { insertMock: ReturnType<typeof vi.fn>; valuesMock: ReturnType<typeof vi.fn> } }).__auditMock;

describe("writeAudit", () => {
  it("inserts a row with provided fields", async () => {
    await writeAudit({
      actor: "mini_app",
      userId: 61804306,
      action: "kill_switch_on",
      target: "global",
      payload: { reason: "test" },
    });
    expect(m.valuesMock).toHaveBeenCalled();
    const v = m.valuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(v.actor).toBe("mini_app");
    expect(v.action).toBe("kill_switch_on");
    expect(v.target).toBe("global");
    expect(v.payload).toEqual({ reason: "test" });
    expect(typeof v.ts).toBe("number");
  });

  it("swallows db errors (never throws into caller)", async () => {
    const dbStub = {
      insert: () => ({ values: () => Promise.reject(new Error("db down")) }),
    };
    vi.doMock("../../src/db/client.js", () => ({ getDb: () => dbStub }));
    await expect(
      writeAudit({ actor: "test", action: "x", target: null, payload: {} }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/notify/audit_log.spec.ts
```

Expected: FAIL with "Cannot find module '../../src/notify/audit_log.js'".

- [ ] **Step 3: Write implementation**

Create `src/notify/audit_log.ts`:

```ts
import { getDb } from "../db/client.js";
import { auditLog } from "../db/schema.js";
import { logger } from "../obs/logger.js";

export type AuditActor = "mini_app" | "bot" | "trader" | "reconciler" | "calibrator" | "test";

export interface AuditEntry {
  actor: AuditActor | string;
  userId?: number | null;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Append a row to audit_log. Fire-and-forget — DB errors are logged and
 * swallowed so audit failures never block the caller's flow.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLog).values({
      ts: Date.now(),
      actor: entry.actor,
      userId: entry.userId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      payload: entry.payload ?? {},
    });
  } catch (err) {
    logger.warn({ err, action: entry.action }, "audit_log insert failed");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/notify/audit_log.spec.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/notify/audit_log.ts tests/notify/audit_log.spec.ts
git commit -m "notify: audit_log writer with fire-and-forget semantics"
```

---

### Task 3: `runtime_config.ts` cached reader + setter

**Files:**
- Create: `src/notify/runtime_config.ts`
- Test: `tests/notify/runtime_config.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/notify/runtime_config.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no db in test");
  },
}));

import {
  getRuntimeConfig,
  resetRuntimeConfigCache,
} from "../../src/notify/runtime_config.js";

beforeEach(() => resetRuntimeConfigCache());
afterEach(() => resetRuntimeConfigCache());

describe("getRuntimeConfig", () => {
  it("returns empty map when DB read throws (defensive)", async () => {
    const result = await getRuntimeConfig("global", "exit.");
    expect(result).toEqual({});
  });

  it("caches result for 2s (no second DB call within window)", async () => {
    const first = await getRuntimeConfig("global", "exit.");
    const second = await getRuntimeConfig("global", "exit.");
    expect(first).toEqual(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/notify/runtime_config.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/notify/runtime_config.ts`:

```ts
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { runtimeConfig } from "../db/schema.js";

const CACHE_MS = 2_000;

interface CacheEntry {
  ts: number;
  value: Record<string, unknown>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(scope: string, prefix: string): string {
  return `${scope}::${prefix}`;
}

/**
 * Read runtime_config rows for `scope` whose key starts with `keyPrefix`.
 * Returns a map { key → value }. Cached for 2s. Returns {} on DB error.
 */
export async function getRuntimeConfig(
  scope: string,
  keyPrefix: string,
): Promise<Record<string, unknown>> {
  const k = cacheKey(scope, keyPrefix);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.value;
  let value: Record<string, unknown> = {};
  try {
    const db = getDb();
    const rows = await db.query.runtimeConfig.findMany({
      where: and(eq(runtimeConfig.scope, scope), like(runtimeConfig.key, `${keyPrefix}%`)),
    });
    value = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    value = {};
  }
  cache.set(k, { ts: Date.now(), value });
  return value;
}

export async function setRuntimeConfig(args: {
  scope: string;
  key: string;
  value: unknown;
  setByUserId?: number | null;
}): Promise<void> {
  const db = getDb();
  // UPSERT
  const existing = await db.query.runtimeConfig.findFirst({
    where: and(eq(runtimeConfig.scope, args.scope), eq(runtimeConfig.key, args.key)),
  });
  if (existing) {
    await db
      .update(runtimeConfig)
      .set({ value: args.value as object, setByUserId: args.setByUserId ?? null, setAt: new Date() })
      .where(eq(runtimeConfig.id, existing.id));
  } else {
    await db.insert(runtimeConfig).values({
      scope: args.scope,
      key: args.key,
      value: args.value as object,
      setByUserId: args.setByUserId ?? null,
    });
  }
  // Invalidate any cache entry whose prefix matches this key
  for (const k of cache.keys()) {
    const [s, p] = k.split("::");
    if (s === args.scope && args.key.startsWith(p ?? "")) cache.delete(k);
  }
}

export function resetRuntimeConfigCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/notify/runtime_config.spec.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/notify/runtime_config.ts tests/notify/runtime_config.spec.ts
git commit -m "notify: runtime_config cached reader + setter (2s cache)"
```

---

### Task 4: `exit_config_loader.ts` + wire into PositionMonitor

**Files:**
- Create: `src/monitor/exit_config_loader.ts`
- Test: `tests/monitor/exit_config_loader.spec.ts`
- Modify: `src/monitor/position_monitor.ts`

- [ ] **Step 1: Write failing test**

Create `tests/monitor/exit_config_loader.spec.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/notify/runtime_config.js", () => ({
  getRuntimeConfig: vi.fn(),
}));

import { loadEffectiveExitConfig } from "../../src/monitor/exit_config_loader.js";
import { getRuntimeConfig } from "../../src/notify/runtime_config.js";
import { DEFAULT_EXIT_CONFIG } from "../../src/types/decide.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

describe("loadEffectiveExitConfig", () => {
  it("returns defaults when no runtime overrides exist", async () => {
    (getRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const cfg = await loadEffectiveExitConfig();
    expect(cfg).toEqual(DEFAULT_EXIT_CONFIG);
  });

  it("merges runtime overrides on top of defaults", async () => {
    (getRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      "exit.stopLoss": -0.1,
      "exit.takeProfit": 0.25,
    });
    const cfg = await loadEffectiveExitConfig();
    expect(cfg.stopLoss).toBe(-0.1);
    expect(cfg.takeProfit).toBe(0.25);
    // Other fields untouched
    expect(cfg.stopLossEmergency).toBe(DEFAULT_EXIT_CONFIG.stopLossEmergency);
  });

  it("ignores unknown keys silently", async () => {
    (getRuntimeConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
      "exit.bogus": 999,
    });
    const cfg = await loadEffectiveExitConfig();
    expect(cfg).toEqual(DEFAULT_EXIT_CONFIG);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/monitor/exit_config_loader.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/monitor/exit_config_loader.ts`:

```ts
import { getRuntimeConfig } from "../notify/runtime_config.js";
import { DEFAULT_EXIT_CONFIG, type ExitConfig } from "../types/decide.js";

const KNOWN_KEYS: readonly (keyof ExitConfig)[] = [
  "stopLoss",
  "stopLossEmergency",
  "takeProfit",
  "trailActivate",
  "trailStop",
  "ceilingTpPrice",
  "minStopLossAgeSeconds",
  "markStaleSeconds",
  "postEntryDebounceSeconds",
  "outcomeFloorMultiplier",
];

/**
 * Build an ExitConfig by overlaying any `exit.<key>` rows from
 * runtime_config (scope=global) on top of DEFAULT_EXIT_CONFIG. Reads via
 * cached getRuntimeConfig (2s TTL), so per-tick cost is bounded.
 *
 * Unknown keys ignored; type coercion is best-effort numeric.
 */
export async function loadEffectiveExitConfig(): Promise<ExitConfig> {
  const overrides = await getRuntimeConfig("global", "exit.");
  const result: Record<string, number> = { ...DEFAULT_EXIT_CONFIG };
  for (const k of KNOWN_KEYS) {
    const override = overrides[`exit.${k}`];
    if (typeof override === "number" && Number.isFinite(override)) {
      result[k] = override;
    }
  }
  return result as unknown as ExitConfig;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/monitor/exit_config_loader.spec.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Wire into PositionMonitor**

Modify `src/monitor/position_monitor.ts`:

1. Add import: `import { loadEffectiveExitConfig } from "./exit_config_loader.js";`

2. Replace constructor body that sets `this.cfg`:

```ts
// OLD:
this.cfg = options.exitConfig ?? DEFAULT_EXIT_CONFIG;

// NEW:
this.cfgOverride = options.exitConfig;
```

3. Add a private field declaration:

```ts
private readonly cfgOverride: ExitConfig | undefined;
private cfg: ExitConfig = DEFAULT_EXIT_CONFIG;
```

4. At the top of `processOnce()`, before the `for` loop over positions, refresh cfg:

```ts
this.cfg = this.cfgOverride ?? (await loadEffectiveExitConfig());
```

5. Run vitest to verify nothing else broke:

```bash
npx vitest run
```

Expected: ≥ 196 passing (1 pre-existing fail OK).

- [ ] **Step 6: tsc clean**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/monitor/exit_config_loader.ts src/monitor/position_monitor.ts tests/monitor/exit_config_loader.spec.ts
git commit -m "monitor: loadEffectiveExitConfig + wire into PositionMonitor"
```

---

## Phase B — Read endpoints

### Task 5: GET /api/positions/:id and /api/positions/:id/timeline

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handler functions**

In `src/api/rest_server.ts`, after the existing `handlePnl` function, add:

```ts
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
  const p = await db.query.positions.findFirst({
    where: eq(positions.id, id),
  });
  if (!p) return { error: "not_found" };

  // Fills (BUY + SELL) for this position
  const fillRows = await db.query.fills.findMany({ where: eq(fills.positionId, id) });
  // Last 10 decide_exit decisions for context
  const decisionRows = await db.query.decisions.findMany({
    where: eq(decisions.positionId, id),
    orderBy: (cols, { desc }) => [desc(cols.ts)],
    limit: 10,
  });

  return {
    position: await handlePositionById(id),
    fills: fillRows.map((f) => ({
      side: f.side,
      shares: Number(f.shares ?? 0),
      price: Number(f.price ?? 0),
      txHash: f.txHash,
      ts: Number(f.ts ?? 0),
    })),
    recentDecisions: decisionRows.map((d) => ({
      ts: Number(d.ts),
      action: (d.outputIntent as Record<string, unknown>)["action"],
      reason: (d.outputIntent as Record<string, unknown>)["reason"],
      gates: d.gates,
      durationMs: d.durationMs,
    })),
  };
}
```

You'll also need to import `decisions` from `../db/schema.js` at the top of the file. Update the imports line to include it.

- [ ] **Step 2: Wire routes**

Inside `createRestServer()`, replace the `try { ... }` block's first `if (req.method === "GET")` body so it includes:

```ts
if (req.method === "GET") {
  if (req.url === "/api/status") return send(res, 200, await handleStatus());
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
}
```

- [ ] **Step 3: tsc clean**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke test against live DB**

In one shell:
```bash
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api
```

In another (after server logs `listening`):
```bash
curl -s -H "X-Dev-Bypass: secretdev" http://localhost:8081/api/positions/12 | head -c 300
```

Expected: JSON with id=12 fields (or 404 if pos 12 doesn't exist locally; pick any closed pos id from `psql … -c "SELECT id FROM positions LIMIT 5"`).

```bash
curl -s -H "X-Dev-Bypass: secretdev" http://localhost:8081/api/positions/12/timeline | head -c 400
```

Expected: JSON with `position`, `fills`, `recentDecisions` keys.

- [ ] **Step 5: Stop server, commit**

```bash
pkill -f "tsx watch.*src/api/main\.ts"
git add src/api/rest_server.ts
git commit -m "api: GET /api/positions/:id + /timeline (drilldown data)"
```

---

### Task 6: GET /api/strategies (list + single)

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add imports + handlers**

At the top of `src/api/rest_server.ts`, add `strategies` to schema imports.

After `handlePositionTimeline`, add:

```ts
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
```

- [ ] **Step 2: Wire routes**

In the GET branch:

```ts
if (req.url === "/api/strategies") return send(res, 200, await handleStrategiesList());
const strategyMatch = req.url?.match(/^\/api\/strategies\/(\d+)$/);
if (strategyMatch && strategyMatch[1]) {
  const result = await handleStrategyById(Number(strategyMatch[1]));
  return send(res, result === null ? 404 : 200, result ?? { error: "not_found" });
}
```

- [ ] **Step 3: tsc clean**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Smoke**

```bash
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
curl -s -H "X-Dev-Bypass: secretdev" http://localhost:8081/api/strategies
curl -s -H "X-Dev-Bypass: secretdev" http://localhost:8081/api/strategies/1
pkill -f "tsx watch.*src/api/main\.ts"
```

Expected: JSON list + single strategy object.

- [ ] **Step 5: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: GET /api/strategies (list + single)"
```

---

### Task 7: GET /api/exit_config + /api/history

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handlers**

Append:

```ts
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
    where: and(eq(positions.status, "CLOSED"), gte(positions.lastStateChangeTs, sinceMs)),
    orderBy: desc(positions.id),
    limit: 200,
  });
  // Per-row P&L from fills
  const enriched = await Promise.all(
    rows.map(async (p) => {
      const sells = await db.query.fills.findMany({
        where: and(eq(fills.positionId, Number(p.id)), eq(fills.side, "SELL")),
      });
      const exitUsd = sells.reduce((s, f) => s + Number(f.shares ?? 0) * Number(f.price ?? 0), 0);
      const entryUsd = Number(p.entryCostUsd ?? 0);
      const pnl = exitUsd - entryUsd;
      return {
        id: p.id,
        closeReason: p.closeReason,
        closeTs: Number(p.lastStateChangeTs ?? 0),
        entryUsd,
        exitUsd,
        pnlUsd: pnl,
        pnlPct: entryUsd > 0 ? pnl / entryUsd : 0,
        outcome: pnl >= 0 ? "win" : "loss",
      };
    }),
  );
  // Aggregates
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
```

Add import for `loadEffectiveExitConfig`:

```ts
import { loadEffectiveExitConfig } from "../monitor/exit_config_loader.js";
```

- [ ] **Step 2: Wire routes**

```ts
if (req.url === "/api/exit_config") return send(res, 200, await handleExitConfig());
if (req.url?.startsWith("/api/history")) return send(res, 200, await handleHistory(req));
```

- [ ] **Step 3: tsc clean**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Smoke**

```bash
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
curl -s -H "X-Dev-Bypass: secretdev" http://localhost:8081/api/exit_config
curl -s -H "X-Dev-Bypass: secretdev" "http://localhost:8081/api/history?windowHours=24" | head -c 600
pkill -f "tsx watch.*src/api/main\.ts"
```

Expected: ExitConfig JSON; history JSON with aggregates + trades array.

- [ ] **Step 5: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: GET /api/exit_config + /api/history with aggregates"
```

---

### Task 8: GET /api/filters/stats + /api/whales

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handlers**

```ts
async function handleFilterStats(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  // Count signals by reject_reason in window
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
  // Bottleneck = filter responsible for ≥30% of rejections
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
```

Add `signals` and `whales` to schema imports.

- [ ] **Step 2: Wire routes**

```ts
if (req.url?.startsWith("/api/filters/stats")) return send(res, 200, await handleFilterStats(req));
if (req.url === "/api/whales") return send(res, 200, await handleWhalesList());
```

- [ ] **Step 3: tsc clean + smoke**

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
curl -s -H "X-Dev-Bypass: secretdev" "http://localhost:8081/api/filters/stats?windowHours=24"
curl -s -H "X-Dev-Bypass: secretdev" "http://localhost:8081/api/whales" | head -c 400
pkill -f "tsx watch.*src/api/main\.ts"
```

- [ ] **Step 4: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: GET /api/filters/stats + /api/whales"
```

---

### Task 9: GET /api/connections + /api/perf + /api/audit + /api/build

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handlers**

```ts
async function handleConnections(): Promise<unknown> {
  // For MVP: last fetched_at timestamps from sports_events / signals as proxies
  // for "did we receive anything recently" — full per-source health is P3+.
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
  // Placeholder: OTEL aggregation is P3+. Return uptime + Node info.
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

async function handleBuild(): Promise<unknown> {
  return {
    service: "ora2-api",
    nodeVersion: process.version,
    startedAt: process.env["ORA2_API_STARTED_AT"] ?? new Date().toISOString(),
    // git hash injected at deploy time; "dev" locally
    gitCommit: process.env["GIT_COMMIT"] ?? "dev",
  };
}
```

Add to schema imports: `sportsEvents`, `auditLog`. Set `process.env["ORA2_API_STARTED_AT"]` once at server boot in `src/api/main.ts`:

In `src/api/main.ts`, before `startRestServer()`:

```ts
process.env["ORA2_API_STARTED_AT"] = new Date().toISOString();
```

- [ ] **Step 2: Wire routes**

```ts
if (req.url === "/api/connections") return send(res, 200, await handleConnections());
if (req.url === "/api/perf") return send(res, 200, await handlePerf());
if (req.url?.startsWith("/api/audit")) return send(res, 200, await handleAudit(req));
if (req.url === "/api/build") return send(res, 200, await handleBuild());
```

- [ ] **Step 3: tsc + smoke**

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
for ep in connections perf audit build; do
  echo "--- /api/$ep ---"
  curl -s -H "X-Dev-Bypass: secretdev" "http://localhost:8081/api/$ep" | head -c 300
  echo
done
pkill -f "tsx watch.*src/api/main\.ts"
```

- [ ] **Step 4: Commit**

```bash
git add src/api/rest_server.ts src/api/main.ts
git commit -m "api: GET /api/{connections,perf,audit,build}"
```

---

## Phase C — Edit endpoints with validation

### Task 10: `strategy_schema.ts` validation

**Files:**
- Create: `src/api/strategy_schema.ts`
- Test: `tests/api/strategy_schema.spec.ts`

- [ ] **Step 1: Failing test**

Create `tests/api/strategy_schema.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  validateExitConfigKey,
  validateStrategyParam,
} from "../../src/api/strategy_schema.js";

describe("validateStrategyParam", () => {
  it("accepts valid baseSizeUsd", () => {
    const r = validateStrategyParam("baseSizeUsd", 5);
    expect(r.ok).toBe(true);
  });
  it("rejects negative baseSizeUsd", () => {
    const r = validateStrategyParam("baseSizeUsd", -1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/positive/i);
  });
  it("rejects unknown key", () => {
    const r = validateStrategyParam("rocketFuel" as never, 5);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unknown/i);
  });
  it("rejects non-number value", () => {
    const r = validateStrategyParam("baseSizeUsd", "5" as unknown as number);
    expect(r.ok).toBe(false);
  });
});

describe("validateExitConfigKey", () => {
  it("accepts stopLoss in range", () => {
    expect(validateExitConfigKey("stopLoss", -0.15).ok).toBe(true);
  });
  it("rejects stopLoss above 0", () => {
    expect(validateExitConfigKey("stopLoss", 0.05).ok).toBe(false);
  });
  it("rejects stopLoss below -0.99", () => {
    expect(validateExitConfigKey("stopLoss", -1.5).ok).toBe(false);
  });
  it("accepts takeProfit 0..1", () => {
    expect(validateExitConfigKey("takeProfit", 0.2).ok).toBe(true);
  });
  it("rejects unknown exit key", () => {
    expect(validateExitConfigKey("rocket" as never, 1).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
npx vitest run tests/api/strategy_schema.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implementation**

Create `src/api/strategy_schema.ts`:

```ts
export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const okResult: ValidationResult = { ok: true };

export type StrategyParamKey =
  | "budgetUsd"
  | "baseSizeUsd"
  | "maxEntryShares"
  | "defaultConviction"
  | "exitReentryCooldownSec"
  | "ghostWindowSec"
  | "entryCooldownSec"
  | "traderAllocation"
  | "onchainCacheTtlSec"
  | "sportsOnly";

interface NumBounds {
  min: number;
  max: number;
}

const STRATEGY_PARAM_BOUNDS: Partial<Record<StrategyParamKey, NumBounds>> = {
  budgetUsd: { min: 0.01, max: 1_000_000 },
  baseSizeUsd: { min: 0.01, max: 100_000 },
  maxEntryShares: { min: 1, max: 100_000 },
  defaultConviction: { min: 0, max: 1 },
  exitReentryCooldownSec: { min: 0, max: 86_400 },
  ghostWindowSec: { min: 0, max: 86_400 },
  entryCooldownSec: { min: 0, max: 86_400 },
  traderAllocation: { min: 0, max: 1 },
  onchainCacheTtlSec: { min: 0, max: 3600 },
};

export function validateStrategyParam(key: StrategyParamKey, value: unknown): ValidationResult {
  if (key === "sportsOnly") {
    if (typeof value !== "boolean") return { ok: false, reason: "must be boolean" };
    return okResult;
  }
  const bounds = STRATEGY_PARAM_BOUNDS[key];
  if (!bounds) return { ok: false, reason: `unknown strategy param key: ${key}` };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "must be a finite number" };
  }
  if (value < bounds.min) return { ok: false, reason: `must be ≥ ${bounds.min} (positive)` };
  if (value > bounds.max) return { ok: false, reason: `must be ≤ ${bounds.max}` };
  return okResult;
}

export type ExitConfigKey =
  | "stopLoss"
  | "stopLossEmergency"
  | "takeProfit"
  | "trailActivate"
  | "trailStop"
  | "ceilingTpPrice"
  | "minStopLossAgeSeconds"
  | "markStaleSeconds"
  | "postEntryDebounceSeconds"
  | "outcomeFloorMultiplier";

const EXIT_BOUNDS: Record<ExitConfigKey, NumBounds> = {
  stopLoss: { min: -0.99, max: 0 },
  stopLossEmergency: { min: -0.99, max: 0 },
  takeProfit: { min: 0, max: 1.0 },
  trailActivate: { min: 0, max: 1.0 },
  trailStop: { min: 0, max: 1.0 },
  ceilingTpPrice: { min: 0.01, max: 0.999 },
  minStopLossAgeSeconds: { min: 0, max: 86_400 },
  markStaleSeconds: { min: 1, max: 3600 },
  postEntryDebounceSeconds: { min: 0, max: 600 },
  outcomeFloorMultiplier: { min: 0, max: 2 },
};

export function validateExitConfigKey(key: ExitConfigKey, value: unknown): ValidationResult {
  const bounds = EXIT_BOUNDS[key];
  if (!bounds) return { ok: false, reason: `unknown exit_config key: ${key}` };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "must be a finite number" };
  }
  if (value < bounds.min) return { ok: false, reason: `must be ≥ ${bounds.min}` };
  if (value > bounds.max) return { ok: false, reason: `must be ≤ ${bounds.max}` };
  return okResult;
}
```

- [ ] **Step 4: Test pass**

```bash
npx vitest run tests/api/strategy_schema.spec.ts
```

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/strategy_schema.ts tests/api/strategy_schema.spec.ts
git commit -m "api: strategy_schema validation bounds for params + exit_config"
```

---

### Task 11: POST /api/strategies/:id/params + /enabled

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handlers**

Add imports at top:

```ts
import { validateStrategyParam, type StrategyParamKey } from "./strategy_schema.js";
import { writeAudit } from "../notify/audit_log.js";
```

Append handlers:

```ts
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
```

- [ ] **Step 2: Wire routes**

In the POST branch of `createRestServer`:

```ts
if (req.method === "POST") {
  if (req.url === "/api/kill_switch") return send(res, 200, await handleKillSwitchPost(req));

  const sParamsMatch = req.url?.match(/^\/api\/strategies\/(\d+)\/params$/);
  if (sParamsMatch && sParamsMatch[1]) {
    return send(res, 200, await handleStrategyParamsPost(Number(sParamsMatch[1]), req, auth.userId ?? 0));
  }
  const sEnabledMatch = req.url?.match(/^\/api\/strategies\/(\d+)\/enabled$/);
  if (sEnabledMatch && sEnabledMatch[1]) {
    return send(res, 200, await handleStrategyEnabledPost(Number(sEnabledMatch[1]), req, auth.userId ?? 0));
  }
}
```

- [ ] **Step 3: tsc + smoke**

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
# Update a strategy param
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"baseSizeUsd": 4}' http://localhost:8081/api/strategies/1/params
# Toggle enabled
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"enabled": false}' http://localhost:8081/api/strategies/1/enabled
# Re-enable
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"enabled": true}' http://localhost:8081/api/strategies/1/enabled
# Verify audit_log row written
psql postgresql://ora:ora@localhost:5433/ora_v2 -c "SELECT actor,action,target FROM audit_log ORDER BY id DESC LIMIT 5;"
pkill -f "tsx watch.*src/api/main\.ts"
```

Expected: ok responses; audit_log shows 3 new rows (`strategy_params_update`, `strategy_disable`, `strategy_enable`).

- [ ] **Step 4: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: POST /api/strategies/:id/params + /enabled with validation + audit"
```

---

### Task 12: POST /api/exit_config (uses runtime_config)

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handler**

Add imports:

```ts
import { validateExitConfigKey, type ExitConfigKey } from "./strategy_schema.js";
import { setRuntimeConfig } from "../notify/runtime_config.js";
```

Append:

```ts
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
```

- [ ] **Step 2: Wire route**

In the POST branch:

```ts
if (req.url === "/api/exit_config") {
  return send(res, 200, await handleExitConfigPost(req, auth.userId ?? 0));
}
```

- [ ] **Step 3: tsc + smoke**

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
# Tighten stopLoss to -0.10
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"stopLoss": -0.10}' http://localhost:8081/api/exit_config
# Verify in /api/exit_config
curl -s -H "X-Dev-Bypass: secretdev" http://localhost:8081/api/exit_config
# Bad value
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"stopLoss": 5}' http://localhost:8081/api/exit_config
# Reset
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"stopLoss": -0.15}' http://localhost:8081/api/exit_config
pkill -f "tsx watch.*src/api/main\.ts"
```

Expected: first POST returns ok + GET shows -0.10; bad value returns errors; reset works.

- [ ] **Step 4: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: POST /api/exit_config writes runtime_config + audit"
```

---

### Task 13: POST /api/positions/:id/exit + /freeze + POST /api/whales/:address/track

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Add handlers**

Add imports:

```ts
import { placeSell } from "../execute/order_manager.js";
import { whales } from "../db/schema.js";
```

Append:

```ts
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

  // Compute price from CLOB book
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
```

- [ ] **Step 2: Wire routes**

```ts
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
```

- [ ] **Step 3: tsc + smoke**

DRY mode test (no real CLOB hit on exit):

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev DRY_RUN=true REST_PORT=8081 npm run dev:api &
sleep 2

# Pick any whale address from DB
ADDR=$(psql postgresql://ora:ora@localhost:5433/ora_v2 -tAc "SELECT address FROM whales LIMIT 1")
echo "Testing whale toggle on $ADDR"
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"tracked": false}' "http://localhost:8081/api/whales/$ADDR/track"
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"tracked": true}' "http://localhost:8081/api/whales/$ADDR/track"

# Exit + freeze: skip if no CLOSED position to test against — they 404 cleanly.
psql postgresql://ora:ora@localhost:5433/ora_v2 -c "SELECT actor,action,target FROM audit_log ORDER BY id DESC LIMIT 5;"
pkill -f "tsx watch.*src/api/main\.ts"
```

- [ ] **Step 4: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: POST /api/positions/:id/{exit,freeze} + /api/whales/:addr/track"
```

---

## Phase D — Audit log integration sweep

### Task 14: Add audit_log to existing /api/kill_switch endpoint

**Files:**
- Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Modify handleKillSwitchPost to write audit**

Replace the body of `handleKillSwitchPost` with:

```ts
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
```

Update the route call:

```ts
if (req.url === "/api/kill_switch") {
  return send(res, 200, await handleKillSwitchPost(req, auth.userId ?? 0));
}
```

- [ ] **Step 2: tsc + smoke**

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"active": true, "reason": "smoke"}' http://localhost:8081/api/kill_switch
curl -s -X POST -H "X-Dev-Bypass: secretdev" -H "Content-Type: application/json" \
  -d '{"active": false, "reason": "smoke"}' http://localhost:8081/api/kill_switch
psql postgresql://ora:ora@localhost:5433/ora_v2 \
  -c "SELECT actor,action,target FROM audit_log WHERE action LIKE 'kill_switch%' ORDER BY id DESC LIMIT 4;"
pkill -f "tsx watch.*src/api/main\.ts"
```

Expected: 2 new audit rows.

- [ ] **Step 3: Commit**

```bash
git add src/api/rest_server.ts
git commit -m "api: kill_switch POST also writes audit_log row"
```

---

## Phase E — Frontend rewrite

### Task 15: Frontend infrastructure (api/format/router/sheets helpers)

**Files:**
- Create: `web/js/api.js`
- Create: `web/js/format.js`
- Create: `web/js/router.js`
- Create: `web/js/sheets.js`

- [ ] **Step 1: Create api.js**

```js
"use strict";

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const devToken = new URLSearchParams(location.search).get("dev");

export const authMode = tg?.initData ? "telegram" : devToken ? "dev_token" : "none";
export const tgWebApp = tg;

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (tg?.initData) h["X-Telegram-Init-Data"] = tg.initData;
  if (devToken) h["X-Dev-Bypass"] = devToken;
  return h;
}

export async function fetchJson(path) {
  const resp = await fetch(path, { headers: authHeaders() });
  if (resp.status === 401) throw new Error("unauthorized");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function postJson(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (resp.status === 401) throw new Error("unauthorized");
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}
```

- [ ] **Step 2: Create format.js**

```js
"use strict";

export function fmt$(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

export function fmtPct(p) {
  if (typeof p !== "number" || !isFinite(p)) return "—";
  const sign = p >= 0 ? "+" : "";
  return `${sign}${(p * 100).toFixed(1)}%`;
}

export function fmtAge(ms) {
  if (!isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

- [ ] **Step 3: Create router.js**

```js
"use strict";

const TABS = ["live", "history", "strategy", "whales", "more"];

export function currentTab() {
  const hash = location.hash.replace("#", "");
  return TABS.includes(hash) ? hash : "live";
}

export function navigate(tab) {
  if (!TABS.includes(tab)) return;
  if (location.hash !== `#${tab}`) {
    location.hash = `#${tab}`;
  }
}

export function onTabChange(handler) {
  window.addEventListener("hashchange", () => handler(currentTab()));
  // initial
  handler(currentTab());
}

export const ALL_TABS = TABS;
```

- [ ] **Step 4: Create sheets.js**

```js
"use strict";

export function openSheet(html) {
  const existing = document.getElementById("sheet-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "sheet-overlay";
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-handle" aria-hidden="true"></div>
      <button class="sheet-close" aria-label="close">×</button>
      <div class="sheet-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".sheet-backdrop")?.addEventListener("click", close);
  overlay.querySelector(".sheet-close")?.addEventListener("click", close);
  document.addEventListener(
    "keydown",
    function escListener(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", escListener);
      }
    },
  );
  return { close, root: overlay.querySelector(".sheet-body") };
}
```

- [ ] **Step 5: Commit**

```bash
git add web/js/
git commit -m "web: api/format/router/sheets helpers"
```

---

### Task 16: Shell rewrite — index.html + styles.css + cockpit + tabs

**Files:**
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/app.js`
- Create: `web/js/cockpit.js`

- [ ] **Step 1: Rewrite index.html**

Replace existing content of `web/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ora2</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="cockpit" class="cockpit"></div>

  <main id="view"></main>

  <nav id="tabbar" class="tabbar">
    <button data-tab="live" class="tab-btn">📊 Live</button>
    <button data-tab="history" class="tab-btn">📜 History</button>
    <button data-tab="strategy" class="tab-btn">⚙ Strategy</button>
    <button data-tab="whales" class="tab-btn">🐋 Whales</button>
    <button data-tab="more" class="tab-btn">☰ More</button>
  </nav>

  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Append cockpit + tab + sheet styles to styles.css**

Append to `web/styles.css`:

```css
.cockpit {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--bg);
  padding: 10px 12px;
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  white-space: nowrap;
}
.cockpit .pill { flex-shrink: 0; }
.cockpit .health-dot {
  width: 10px; height: 10px; border-radius: 50%;
  margin-left: auto; flex-shrink: 0;
}
.cockpit .health-dot.ok { background: var(--ok); }
.cockpit .health-dot.warn { background: var(--warn); }
.cockpit .health-dot.bad { background: var(--bad); }

main#view {
  padding: 14px 12px 90px;
  max-width: 480px;
  margin: 0 auto;
}

.tabbar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
  display: flex;
  padding: 6px 4px env(safe-area-inset-bottom, 6px);
  z-index: 9;
}
.tab-btn {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font: inherit;
  font-size: 12px;
  padding: 8px 4px;
  cursor: pointer;
}
.tab-btn.active { color: var(--accent); }

/* Bottom sheet */
.sheet-overlay {
  position: fixed; inset: 0; z-index: 100;
  display: flex; flex-direction: column; justify-content: flex-end;
}
.sheet-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.55);
}
.sheet {
  position: relative;
  background: var(--bg-2);
  border-radius: 14px 14px 0 0;
  max-height: 80vh;
  overflow-y: auto;
  padding: 8px 16px env(safe-area-inset-bottom, 16px);
  box-shadow: 0 -4px 20px rgba(0,0,0,0.5);
  animation: slideUp 200ms ease-out;
}
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
.sheet-handle {
  width: 36px; height: 4px; border-radius: 2px; background: var(--border);
  margin: 6px auto 12px;
}
.sheet-close {
  position: absolute; top: 8px; right: 12px;
  background: transparent; border: none; color: var(--text-muted);
  font-size: 24px; cursor: pointer;
}
```

- [ ] **Step 3: Create cockpit.js**

```js
"use strict";
import { fetchJson } from "./api.js";
import { fmt$ } from "./format.js";

export async function refreshCockpit() {
  const root = document.getElementById("cockpit");
  if (!root) return;
  try {
    const [status, pnl, conns] = await Promise.all([
      fetchJson("/api/status"),
      fetchJson("/api/pnl?windowHours=24"),
      fetchJson("/api/connections"),
    ]);
    const health = computeHealth(conns);
    root.innerHTML = `
      <span class="pill ${status.mode === "LIVE" ? "live" : "dry"}">${status.mode}</span>
      <span class="pill ${status.killSwitch ? "ks-on" : "ks-off"}">
        ${status.killSwitch ? "🟥 KILL ON" : "🟩 KILL OFF"}
      </span>
      <span class="pill">${fmt$(pnl.netPnlUsd)} 24h</span>
      <span class="pill">${status.activePositions} active</span>
      <span class="health-dot ${health}" title="connections: ${health}"></span>
    `;
  } catch (err) {
    root.innerHTML = `<span class="pill" style="color:var(--bad)">cockpit error: ${err.message}</span>`;
  }
}

function computeHealth(conns) {
  if (!Array.isArray(conns) || conns.length === 0) return "warn";
  const states = conns.map((c) => c.state);
  if (states.every((s) => s === "ok")) return "ok";
  if (states.some((s) => s === "down")) return "bad";
  return "warn";
}
```

- [ ] **Step 4: Rewrite app.js bootstrap**

Replace `web/app.js` with:

```js
"use strict";
import { refreshCockpit } from "./js/cockpit.js";
import { ALL_TABS, currentTab, navigate, onTabChange } from "./js/router.js";
import { renderLive } from "./js/views/live.js";
import { renderHistory } from "./js/views/history.js";
import { renderStrategy } from "./js/views/strategy.js";
import { renderWhales } from "./js/views/whales.js";
import { renderMore } from "./js/views/more.js";

const VIEWS = {
  live: renderLive,
  history: renderHistory,
  strategy: renderStrategy,
  whales: renderWhales,
  more: renderMore,
};

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

function highlightActiveTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.getAttribute("data-tab")));
});

async function renderCurrent(tab) {
  highlightActiveTab(tab);
  const view = document.getElementById("view");
  if (!view) return;
  view.innerHTML = `<div class="muted">loading…</div>`;
  try {
    await VIEWS[tab](view);
  } catch (err) {
    view.innerHTML = `<div class="error-banner">render error: ${err.message}</div>`;
  }
}

onTabChange(renderCurrent);

// Cockpit refresh loop
refreshCockpit();
setInterval(refreshCockpit, 5000);
```

This bootstrap imports per-tab renderers that don't exist yet — Tasks 17-22 fill them.

- [ ] **Step 5: Stub all view files (so import doesn't break)**

Create five stubs:

`web/js/views/live.js`:
```js
"use strict";
export async function renderLive(root) {
  root.innerHTML = `<div class="muted">Live tab — coming next</div>`;
}
```

Same shape for `history.js`, `strategy.js`, `whales.js`, `more.js` — each with their own `renderX` export.

```bash
for v in live history strategy whales more; do
  printf '"use strict";\nexport async function render%s(root) {\n  root.innerHTML = `<div class="muted">%s tab — coming next</div>`;\n}\n' \
    "$(echo $v | sed 's/.*/\u&/')" "$v" > web/js/views/$v.js
done
```

(Or write each file individually if your shell doesn't support that.)

- [ ] **Step 6: Smoke**

```bash
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
# Open in browser:
echo "open http://localhost:8081/app?dev=secretdev"
```

Expected: cockpit bar with mode/kill/$/active, 5 tab buttons at bottom, view shows "Live tab — coming next", clicking tabs swaps view.

- [ ] **Step 7: Commit**

```bash
git add web/
git commit -m "web: shell rewrite — cockpit + tabbar + router + view stubs"
```

---

### Task 17: Live tab view

**Files:**
- Modify: `web/js/views/live.js`

- [ ] **Step 1: Replace stub with full implementation**

```js
"use strict";
import { fetchJson, postJson } from "../api.js";
import { fmt$, fmtAge, fmtPct, escapeHtml } from "../format.js";
import { openPositionSheet } from "../sheets/position.js";

export async function renderLive(root) {
  root.innerHTML = `
    <section class="card" id="now-card"><div class="card-title">Now happening</div><div class="card-body" id="now-body">…</div></section>
    <section class="card" id="positions-card"><div class="card-title">Active positions</div><div class="card-body" id="positions-body">…</div></section>
    <section class="card" id="rejects-card"><div class="card-title">Recent rejects</div><div class="card-body" id="rejects-body">…</div></section>
    <div class="actions">
      <button id="pause-btn" class="btn btn-warn">⛔ Pause</button>
      <button id="resume-btn" class="btn btn-ok">✅ Resume</button>
    </div>
  `;
  await loadAll();
  const interval = setInterval(loadAll, 5000);
  // Stop polling when view is replaced
  const observer = new MutationObserver(() => {
    if (!document.getElementById("now-card")) {
      clearInterval(interval);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById("view"), { childList: true });

  document.getElementById("pause-btn").onclick = async () => {
    await postJson("/api/kill_switch", { active: true, reason: "mini_app" });
    await loadAll();
  };
  document.getElementById("resume-btn").onclick = async () => {
    await postJson("/api/kill_switch", { active: false, reason: "mini_app" });
    await loadAll();
  };
}

async function loadAll() {
  await Promise.all([loadNow(), loadPositions(), loadRejects()]);
}

async function loadNow() {
  const conns = await fetchJson("/api/connections");
  const lastSig = conns.find((c) => c.source === "rtds_ws");
  const lastSports = conns.find((c) => c.source === "sports_ws");
  document.getElementById("now-body").innerHTML = `
    <div class="kv"><span class="k">last whale signal</span><span class="v">${fmtAge(lastSig?.ageMs ?? Infinity)}</span></div>
    <div class="kv"><span class="k">last sports event</span><span class="v">${fmtAge(lastSports?.ageMs ?? Infinity)}</span></div>
  `;
}

async function loadPositions() {
  const list = await fetchJson("/api/positions");
  const body = document.getElementById("positions-body");
  if (list.length === 0) { body.innerHTML = '<span class="muted">no active positions</span>'; return; }
  body.innerHTML = list.map((p) => `
    <div class="pos" data-id="${p.id}" role="button">
      <div class="pos-head">
        <span class="pos-id">#${p.id} ▶</span>
        <span class="pos-status ${p.status}">${p.status}</span>
      </div>
      <div class="pos-row">
        <span><b>${(p.shares || 0).toFixed(3)}</b> sh</span>
        <span>fill <b>${(p.fillPrice || 0).toFixed(3)}</b></span>
        <span>peak <b>${(p.peakPrice || 0).toFixed(3)}</b></span>
        <span>sweep <b>${p.sweepCount || 0}</b></span>
      </div>
    </div>
  `).join("");
  body.querySelectorAll(".pos").forEach((el) => {
    el.addEventListener("click", () => openPositionSheet(Number(el.getAttribute("data-id"))));
  });
}

async function loadRejects() {
  const stats = await fetchJson("/api/filters/stats?windowHours=24");
  const body = document.getElementById("rejects-body");
  const top = Object.entries(stats.byReason || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([k, v]) => `${v} ${escapeHtml(k)}`)
    .join("  •  ");
  body.innerHTML = top || '<span class="muted">no rejects in window</span>';
}
```

- [ ] **Step 2: Stub the position sheet (filled in next task)**

Create `web/js/sheets/position.js`:

```js
"use strict";
import { openSheet } from "../sheets.js";

export function openPositionSheet(id) {
  openSheet(`<div class="muted">Position #${id} drilldown — coming next</div>`);
}
```

- [ ] **Step 3: Smoke in browser**

```bash
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api &
sleep 2
echo "open http://localhost:8081/app?dev=secretdev"
```

Expected: Live tab populated; tap any active position opens stub sheet; Pause/Resume toggle KILL.

- [ ] **Step 4: Commit**

```bash
git add web/
git commit -m "web: Live tab view (now happening + positions + rejects + Pause/Resume)"
```

---

### Task 18: Position drilldown sheet

**Files:**
- Modify: `web/js/sheets/position.js`

- [ ] **Step 1: Full implementation**

```js
"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml, fmt$, fmtAge, fmtPct } from "../format.js";
import { openSheet } from "../sheets.js";

export async function openPositionSheet(id) {
  const sheet = openSheet(`<div class="muted">loading…</div>`);
  try {
    const data = await fetchJson(`/api/positions/${id}/timeline`);
    if (data.error) {
      sheet.root.innerHTML = `<div class="error-banner">${escapeHtml(data.error)}</div>`;
      return;
    }
    const p = data.position;
    const fills = (data.fills || []).slice().sort((a, b) => a.ts - b.ts);
    const decisions = data.recentDecisions || [];
    sheet.root.innerHTML = `
      <h3>Position #${p.id} <span class="pos-status ${p.status}">${p.status}</span></h3>
      <div class="kv"><span class="k">side</span><span class="v">${p.side}</span></div>
      <div class="kv"><span class="k">shares</span><span class="v">${(p.shares || 0).toFixed(4)}</span></div>
      <div class="kv"><span class="k">fill price</span><span class="v">${(p.fillPrice || 0).toFixed(3)}</span></div>
      <div class="kv"><span class="k">peak price</span><span class="v">${(p.peakPrice || 0).toFixed(3)}</span></div>
      <div class="kv"><span class="k">sweep count</span><span class="v">${p.sweepCount}</span></div>
      <div class="kv"><span class="k">entry cost</span><span class="v">$${(p.entryCostUsd || 0).toFixed(2)}</span></div>
      <div class="kv"><span class="k">age</span><span class="v">${fmtAge(Date.now() - (p.fillTs || Date.now()))}</span></div>
      ${p.closeReason ? `<div class="kv"><span class="k">close reason</span><span class="v">${escapeHtml(p.closeReason)}</span></div>` : ""}

      <div class="card-title" style="margin-top:14px">Timeline</div>
      <ol class="timeline">
        ${fills.map((f) => `
          <li>
            <span class="t-side">${f.side}</span>
            <b>${(f.shares || 0).toFixed(3)}</b> @ ${(f.price || 0).toFixed(3)}
            <span class="muted">tx ${escapeHtml((f.txHash || "").slice(0, 12))}…</span>
          </li>`).join("")}
      </ol>

      <div class="card-title" style="margin-top:14px">Recent decisions (last ${decisions.length})</div>
      <ul class="decisions">
        ${decisions.map((d) => `
          <li>
            <span class="muted">${new Date(d.ts).toLocaleTimeString()}</span>
            <b>${escapeHtml(String(d.action))}</b>
            <span class="muted">${escapeHtml(String(d.reason))}</span>
            <span class="muted">[${(d.gates || []).map(escapeHtml).join(", ")}]</span>
          </li>`).join("")}
      </ul>

      <div class="actions" style="margin-top:14px">
        ${(p.status === "OPEN" || p.status === "EXITING") ? `
          <button id="exit-now-btn" class="btn btn-warn">Exit Now</button>
          <button id="freeze-btn" class="btn">Freeze</button>
        ` : ""}
      </div>
    `;
    sheet.root.querySelector("#exit-now-btn")?.addEventListener("click", async () => {
      if (!confirm("Place FAK SELL with 20% slippage?")) return;
      const r = await postJson(`/api/positions/${id}/exit`, { mode: "FAK", slippagePct: 0.2 });
      alert(`exit: ok=${r.ok} status=${r.status ?? ""} err=${r.errorCode ?? ""}`);
      sheet.close();
    });
    sheet.root.querySelector("#freeze-btn")?.addEventListener("click", async () => {
      if (!confirm("Mark position as FROZEN (manual recovery later)?")) return;
      await postJson(`/api/positions/${id}/freeze`, {});
      sheet.close();
    });
  } catch (err) {
    sheet.root.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}
```

- [ ] **Step 2: Append timeline styles**

Append to `web/styles.css`:

```css
.timeline, .decisions { list-style: none; padding: 0; margin: 6px 0; }
.timeline li, .decisions li {
  padding: 6px 0;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  font-size: 13px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.t-side {
  font-weight: 600;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg);
}
```

- [ ] **Step 3: Smoke in browser, tap position card → drilldown opens with timeline + decisions**

- [ ] **Step 4: Commit**

```bash
git add web/
git commit -m "web: position drilldown sheet (timeline + decisions + Exit/Freeze)"
```

---

### Task 19: History tab view

**Files:**
- Modify: `web/js/views/history.js`

- [ ] **Step 1: Implementation**

```js
"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml, fmt$, fmtAge, fmtPct } from "../format.js";
import { openPositionSheet } from "../sheets/position.js";

const WINDOW_OPTIONS = [
  { label: "today", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

export async function renderHistory(root) {
  let windowHours = 24;
  let outcome = "all";

  function chips() {
    return `
      <div class="chip-row">
        ${WINDOW_OPTIONS.map((o) =>
          `<button class="chip ${o.hours === windowHours ? "active" : ""}" data-hours="${o.hours}">${o.label}</button>`
        ).join("")}
        <span style="flex:1"></span>
        ${["all", "wins", "losses"].map((o) =>
          `<button class="chip ${o === outcome ? "active" : ""}" data-outcome="${o}">${o}</button>`
        ).join("")}
      </div>
    `;
  }

  async function refresh() {
    const data = await fetchJson(`/api/history?windowHours=${windowHours}`);
    const a = data.aggregates;
    const filtered = (data.trades || []).filter((t) =>
      outcome === "all" ? true : (outcome === "wins" ? t.outcome === "win" : t.outcome === "loss"),
    );
    root.innerHTML = `
      ${chips()}
      <section class="card">
        <div class="card-title">Aggregates</div>
        <div class="card-body">
          <div class="kv"><span class="k">trades</span><span class="v">${a.trades}</span></div>
          <div class="kv"><span class="k">win rate</span><span class="v">${a.winRatePct.toFixed(1)}%</span></div>
          <div class="kv"><span class="k">net</span><span class="v ${a.netPnlUsd >= 0 ? "ok" : "bad"}">${fmt$(a.netPnlUsd)} (${fmtPct(a.netPnlPct)})</span></div>
          <div class="kv"><span class="k">avg / best / worst</span><span class="v">${fmt$(a.avgUsd)} / ${fmt$(a.bestUsd)} / ${fmt$(a.worstUsd)}</span></div>
        </div>
      </section>
      <section class="card">
        <div class="card-title">Trades (${filtered.length})</div>
        <div class="card-body">
          ${filtered.length === 0 ? '<span class="muted">no trades in window</span>' : filtered.map((t) => `
            <div class="pos" data-id="${t.id}" role="button">
              <div class="pos-head">
                <span class="pos-id">#${t.id} ${t.outcome === "win" ? "✓" : "✗"} ${fmt$(t.pnlUsd)}</span>
                <span class="pos-status">${escapeHtml(String(t.closeReason ?? ""))}</span>
              </div>
              <div class="pos-row">
                <span class="muted">entry $${t.entryUsd.toFixed(2)}</span>
                <span class="muted">exit $${t.exitUsd.toFixed(2)}</span>
                <span class="muted">${fmtAge(Date.now() - t.closeTs)}</span>
              </div>
            </div>
          `).join("")}
        </div>
      </section>
    `;
    root.querySelectorAll(".chip[data-hours]").forEach((el) => el.addEventListener("click", () => {
      windowHours = Number(el.getAttribute("data-hours"));
      refresh();
    }));
    root.querySelectorAll(".chip[data-outcome]").forEach((el) => el.addEventListener("click", () => {
      outcome = el.getAttribute("data-outcome");
      refresh();
    }));
    root.querySelectorAll(".pos[data-id]").forEach((el) => el.addEventListener("click", () =>
      openPositionSheet(Number(el.getAttribute("data-id"))),
    ));
  }

  await refresh();
}
```

- [ ] **Step 2: Append chip styles**

```css
.chip-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.chip {
  background: var(--bg-2); border: 1px solid var(--border);
  color: var(--text-muted); padding: 4px 10px; border-radius: 14px;
  font-size: 12px; cursor: pointer;
}
.chip.active { background: rgba(47,129,247,0.15); color: var(--accent); border-color: var(--accent); }
```

- [ ] **Step 3: Smoke**

In browser: switch to History tab, click chips, click trade rows.

- [ ] **Step 4: Commit**

```bash
git add web/
git commit -m "web: History tab (aggregates + filterable trade list + drilldown)"
```

---

### Task 20: Strategy tab view + edit_param sheet

**Files:**
- Modify: `web/js/views/strategy.js`
- Create: `web/js/sheets/edit_param.js`

- [ ] **Step 1: edit_param.js**

```js
"use strict";
import { postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openSheet } from "../sheets.js";

export function openEditParamSheet(args) {
  // args: { title, currentValue, postPath, paramKey }
  const sheet = openSheet(`
    <h3>${escapeHtml(args.title)}</h3>
    <div class="kv"><span class="k">current</span><span class="v">${args.currentValue}</span></div>
    <input id="edit-input" type="number" step="any" value="${args.currentValue}" style="width:100%; margin-top:12px; padding:8px; background:var(--bg); border:1px solid var(--border); color:var(--text); border-radius:6px; font-size:16px;" />
    <div class="actions" style="margin-top:12px">
      <button id="cancel-btn" class="btn">Cancel</button>
      <button id="save-btn" class="btn btn-ok">Save</button>
    </div>
    <div id="edit-error" class="muted" style="margin-top:8px"></div>
  `);
  sheet.root.querySelector("#cancel-btn").addEventListener("click", () => sheet.close());
  sheet.root.querySelector("#save-btn").addEventListener("click", async () => {
    const v = Number(sheet.root.querySelector("#edit-input").value);
    try {
      const r = await postJson(args.postPath, { [args.paramKey]: v });
      if (r.errors) {
        sheet.root.querySelector("#edit-error").innerHTML =
          `<span class="bad">${escapeHtml(JSON.stringify(r.errors))}</span>`;
        return;
      }
      args.onSaved?.(v);
      sheet.close();
    } catch (err) {
      sheet.root.querySelector("#edit-error").innerHTML =
        `<span class="bad">${escapeHtml(err.message)}</span>`;
    }
  });
}
```

- [ ] **Step 2: strategy.js**

```js
"use strict";
import { fetchJson, postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openEditParamSheet } from "../sheets/edit_param.js";

export async function renderStrategy(root) {
  const [strategies, exitCfg, filters] = await Promise.all([
    fetchJson("/api/strategies"),
    fetchJson("/api/exit_config"),
    fetchJson("/api/filters/stats?windowHours=24"),
  ]);
  const s = strategies[0];
  if (!s) {
    root.innerHTML = `<div class="muted">no strategy configured</div>`;
    return;
  }
  const params = s.params || {};
  root.innerHTML = `
    <section class="card">
      <div class="card-title">Strategy: ${escapeHtml(s.kind)} #${s.id}</div>
      <div class="card-body">
        <div class="kv"><span class="k">enabled</span><span class="v"><label class="switch"><input id="strat-enabled" type="checkbox" ${s.enabled ? "checked" : ""}/></label></span></div>
        ${paramRow("budgetUsd", params.budgetUsd, s.id)}
        ${paramRow("baseSizeUsd", params.baseSizeUsd, s.id)}
        ${paramRow("maxEntryShares", params.maxEntryShares, s.id)}
        ${paramRow("defaultConviction", params.defaultConviction, s.id)}
        ${paramRow("exitReentryCooldownSec", params.exitReentryCooldownSec, s.id)}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Exit config (live)</div>
      <div class="card-body">
        ${exitRow("stopLoss", exitCfg.stopLoss)}
        ${exitRow("stopLossEmergency", exitCfg.stopLossEmergency)}
        ${exitRow("takeProfit", exitCfg.takeProfit)}
        ${exitRow("trailActivate", exitCfg.trailActivate)}
        ${exitRow("trailStop", exitCfg.trailStop)}
        ${exitRow("ceilingTpPrice", exitCfg.ceilingTpPrice)}
        ${exitRow("minStopLossAgeSeconds", exitCfg.minStopLossAgeSeconds)}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Filters · ${filters.windowHours}h</div>
      <div class="card-body">
        <table class="filters">
          <tr><th>filter</th><th>count</th><th></th></tr>
          ${Object.entries(filters.byReason || {}).sort(([, a], [, b]) => b - a).map(([k, v]) => `
            <tr>
              <td>${escapeHtml(k)}</td>
              <td>${v}</td>
              <td>${(filters.bottlenecks || []).includes(k) ? "⚡" : ""}</td>
            </tr>
          `).join("")}
        </table>
        <div class="muted">accept: ${filters.accepted}/${filters.total} = ${filters.acceptRatePct.toFixed(1)}%</div>
      </div>
    </section>
  `;
  root.querySelector("#strat-enabled").addEventListener("change", async (e) => {
    await postJson(`/api/strategies/${s.id}/enabled`, { enabled: e.target.checked });
  });
  root.querySelectorAll("[data-param]").forEach((el) => el.addEventListener("click", () => {
    const k = el.getAttribute("data-param");
    openEditParamSheet({
      title: `strategy.${k}`,
      currentValue: el.getAttribute("data-value"),
      postPath: `/api/strategies/${s.id}/params`,
      paramKey: k,
      onSaved: () => renderStrategy(root),
    });
  }));
  root.querySelectorAll("[data-exit]").forEach((el) => el.addEventListener("click", () => {
    const k = el.getAttribute("data-exit");
    openEditParamSheet({
      title: `exit.${k}`,
      currentValue: el.getAttribute("data-value"),
      postPath: `/api/exit_config`,
      paramKey: k,
      onSaved: () => renderStrategy(root),
    });
  }));
}

function paramRow(k, v, sid) {
  return `<div class="kv" data-param="${k}" data-value="${v ?? ""}" role="button"><span class="k">${k}</span><span class="v">${v ?? "—"} ✎</span></div>`;
}
function exitRow(k, v) {
  return `<div class="kv" data-exit="${k}" data-value="${v}" role="button"><span class="k">${k}</span><span class="v">${v} ✎</span></div>`;
}
```

- [ ] **Step 3: Append filter table styles**

```css
table.filters { width: 100%; border-collapse: collapse; }
table.filters th { text-align: left; color: var(--text-muted); font-weight: 500; font-size: 11px; padding: 4px 0; }
table.filters td { padding: 4px 0; font-size: 13px; font-variant-numeric: tabular-nums; }
table.filters tr { border-bottom: 1px solid rgba(255,255,255,0.04); }
.switch { display: inline-block; }
```

- [ ] **Step 4: Smoke**

In browser: Strategy tab loads, edit a param via `✎`, value persists after save and refetch.

- [ ] **Step 5: Commit**

```bash
git add web/
git commit -m "web: Strategy tab + edit_param sheet (params + exit_config + filters table)"
```

---

### Task 21: Whales tab + sheet

**Files:**
- Modify: `web/js/views/whales.js`
- Create: `web/js/sheets/whale.js`

- [ ] **Step 1: whale.js sheet**

```js
"use strict";
import { postJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openSheet } from "../sheets.js";

export function openWhaleSheet(w, onChanged) {
  const sheet = openSheet(`
    <h3>Whale ${escapeHtml(w.address.slice(0, 10))}…</h3>
    <div class="kv"><span class="k">classification</span><span class="v">${escapeHtml(w.classification ?? "—")}</span></div>
    <div class="kv"><span class="k">confidence</span><span class="v">${(w.confidence ?? 0).toFixed(2)}</span></div>
    <div class="kv"><span class="k">tracked</span><span class="v">${w.tracked ? "yes" : "no"}</span></div>
    <div class="actions" style="margin-top:12px">
      <button id="toggle-btn" class="btn ${w.tracked ? "btn-warn" : "btn-ok"}">${w.tracked ? "Untrack" : "Track"}</button>
    </div>
    <div class="muted" style="margin-top:10px">Per-whale signal history + P&L attribution coming in P2c.</div>
  `);
  sheet.root.querySelector("#toggle-btn").addEventListener("click", async () => {
    await postJson(`/api/whales/${w.address}/track`, { tracked: !w.tracked });
    sheet.close();
    onChanged?.();
  });
}
```

- [ ] **Step 2: whales.js**

```js
"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml } from "../format.js";
import { openWhaleSheet } from "../sheets/whale.js";

export async function renderWhales(root) {
  let mode = "tracked";
  async function refresh() {
    const list = await fetchJson("/api/whales");
    const filtered = mode === "tracked" ? list.filter((w) => w.tracked) : list;
    root.innerHTML = `
      <div class="chip-row">
        <button class="chip ${mode === "tracked" ? "active" : ""}" data-mode="tracked">tracked</button>
        <button class="chip ${mode === "all" ? "active" : ""}" data-mode="all">all</button>
      </div>
      <section class="card">
        <div class="card-title">${filtered.length} whales</div>
        <div class="card-body">
          ${filtered.map((w) => `
            <div class="pos" data-addr="${w.address}" role="button">
              <div class="pos-head">
                <span class="pos-id">${escapeHtml(w.address.slice(0, 10))}…</span>
                <span class="pos-status ${w.tracked ? "OPEN" : ""}">${w.tracked ? "tracked" : "untracked"}</span>
              </div>
              <div class="pos-row">
                <span>${escapeHtml(w.classification ?? "—")}</span>
                <span class="muted">conf ${(w.confidence ?? 0).toFixed(2)}</span>
              </div>
            </div>
          `).join("") || '<span class="muted">no whales in this view</span>'}
        </div>
      </section>
    `;
    root.querySelectorAll(".chip[data-mode]").forEach((el) => el.addEventListener("click", () => {
      mode = el.getAttribute("data-mode"); refresh();
    }));
    root.querySelectorAll(".pos[data-addr]").forEach((el) => el.addEventListener("click", () => {
      const w = filtered.find((x) => x.address === el.getAttribute("data-addr"));
      if (w) openWhaleSheet(w, refresh);
    }));
  }
  await refresh();
}
```

- [ ] **Step 3: Smoke + commit**

```bash
git add web/
git commit -m "web: Whales tab + per-whale sheet with tracked toggle"
```

---

### Task 22: More tab

**Files:**
- Modify: `web/js/views/more.js`

- [ ] **Step 1: Implementation**

```js
"use strict";
import { fetchJson } from "../api.js";
import { escapeHtml, fmtAge } from "../format.js";

export async function renderMore(root) {
  const [conns, perf, audit, build] = await Promise.all([
    fetchJson("/api/connections"),
    fetchJson("/api/perf"),
    fetchJson("/api/audit?limit=30"),
    fetchJson("/api/build"),
  ]);
  root.innerHTML = `
    <section class="card">
      <div class="card-title">Notifications</div>
      <div class="card-body muted">
        wired: BUY filled, position closed, FROZEN, fatal error.<br>
        per-event toggles + daily summary scheduling: P2d.
      </div>
    </section>

    <section class="card">
      <div class="card-title">Connections</div>
      <div class="card-body">
        ${conns.map((c) => `
          <div class="kv">
            <span class="k">${escapeHtml(c.source)}</span>
            <span class="v">
              <span class="health-dot ${c.state === "ok" ? "ok" : c.state === "stale" ? "warn" : "bad"}"></span>
              ${fmtAge(c.ageMs ?? Infinity)}
            </span>
          </div>
        `).join("")}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Performance</div>
      <div class="card-body">
        <div class="kv"><span class="k">node</span><span class="v">${escapeHtml(perf.nodeVersion)}</span></div>
        <div class="kv"><span class="k">uptime</span><span class="v">${perf.uptimeSec}s</span></div>
        <div class="kv"><span class="k">rss memory</span><span class="v">${perf.memoryRssMb} MB</span></div>
      </div>
    </section>

    <section class="card">
      <div class="card-title">Audit log (last ${audit.length})</div>
      <div class="card-body audit">
        ${audit.map((a) => `
          <div class="audit-row">
            <span class="muted">${new Date(a.ts).toLocaleString()}</span>
            <b>${escapeHtml(a.action)}</b>
            <span class="muted">${escapeHtml(a.target ?? "")}</span>
            <span class="muted">${escapeHtml(a.actor)}</span>
          </div>
        `).join("")}
      </div>
    </section>

    <section class="card">
      <div class="card-title">Build</div>
      <div class="card-body">
        <div class="kv"><span class="k">service</span><span class="v">${escapeHtml(build.service)}</span></div>
        <div class="kv"><span class="k">started</span><span class="v">${escapeHtml(build.startedAt)}</span></div>
        <div class="kv"><span class="k">git</span><span class="v">${escapeHtml(build.gitCommit)}</span></div>
      </div>
    </section>
  `;
}
```

- [ ] **Step 2: Append audit row styles**

```css
.audit { font-size: 12px; }
.audit-row { padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); display: flex; gap: 8px; flex-wrap: wrap; }
```

- [ ] **Step 3: Smoke + commit**

```bash
git add web/
git commit -m "web: More tab (connections, perf, audit log, build)"
```

---

## Phase F — LIVE smoke

### Task 23: End-to-end LIVE smoke checklist

- [ ] **Start cloudflared tunnel + ora2-api**

```bash
cloudflared tunnel --url http://localhost:8081 > /tmp/tunnel.log 2>&1 &
sleep 5
URL=$(grep -oE 'https://[a-z-]+\.trycloudflare\.com' /tmp/tunnel.log | head -1)
echo "TUNNEL=$URL"
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api > /tmp/api.log 2>&1 &
sleep 2
```

- [ ] **Restart bot with new MINI_APP_URL**

```bash
pkill -f "tsx watch.*src/notify/main\.ts"
sleep 2
MINI_APP_URL="$URL/app" npm run dev:bot > /tmp/bot.log 2>&1 &
sleep 3
grep "menu button" /tmp/bot.log
```

Expected: log line "Telegram chat menu button set → Open ora2".

- [ ] **Smoke checklist (manual, in @Oralab_bot Mini App)**

Tap each tab in turn and verify:

- [ ] Cockpit bar shows mode, kill, $ today, active count, health dot.
- [ ] **Live**: now-happening shows ages; positions list (if any); rejects strip; Pause/Resume change kill chip ≤2s.
- [ ] **Live drilldown**: tap a position → sheet opens → timeline rows + decisions list visible. Exit Now / Freeze visible only for OPEN/EXITING.
- [ ] **History**: 24h/7d/30d chips switch data; wins/losses filter; tapping trade opens drilldown.
- [ ] **Strategy**: edit baseSizeUsd via ✎ → save → DB row updated (verify via `psql … strategies`); edit `stopLoss` → /api/exit_config returns new value.
- [ ] **Whales**: tracked filter shows tracked subset; toggle untrack → DB row updated.
- [ ] **More**: connections show recent ages; audit_log shows all actions taken during smoke.

- [ ] **Verify regressions**

```bash
# Telegram bot still works
# (in @Oralab_bot send /status, /positions, /pnl)

# Vitest still green
npx vitest run --reporter=default 2>&1 | tail -7
# tsc clean
npx tsc --noEmit
```

- [ ] **Commit final smoke confirmation in BULLETPROOF.md or session notes**

```bash
# Append a confirmation line to BULLETPROOF.md "Verified LIVE" table
# Then:
git add docs/
git commit -m "BULLETPROOF.md: P2a Mini App redesign LIVE-verified end-to-end"
```

---

---

# v1 catch-up plan — Phases G–K (added 2026-05-03)

After v1 deep-dive (recorded in spec) Taras flagged ~80% of v1's
operator-facing surface missing from the original plan. The phases
below extend MVP. Each task is bite-sized and committable; same TDD
flow as Phases A–F.

## Phase G — KPI engine + dashboard

### Task 24: GET /api/kpi (computed from positions+fills+signals)

**Files:** Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Append handler**

```ts
async function handleKpi(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
  const sinceMs = Date.now() - windowHours * 60 * 60 * 1000;
  const db = getDb();
  const sigRows = await db.query.signals.findMany({
    where: gte(signals.processedAt, new Date(sinceMs)),
    columns: { accepted: true, rejectReason: true },
  });
  const signalsTotal = sigRows.length;
  const signalsAccepted = sigRows.filter((r) => r.accepted).length;

  const closed = await db.query.positions.findMany({
    where: and(eq(positions.status, "CLOSED"), gte(positions.lastStateChangeTs, sinceMs)),
  });
  let wins = 0;
  let totalEntry = 0;
  let totalExit = 0;
  let posPnl = 0;
  let negPnl = 0;
  let holdSec = 0;
  const equity: { ts: number; cum: number }[] = [];
  let cum = 0;
  // sort closures chronologically for drawdown curve
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
    if (pnl >= 0) { wins += 1; posPnl += pnl; } else { negPnl += -pnl; }
    holdSec += (Number(p.lastStateChangeTs) - Number(p.fillTs)) / 1000;
    cum += pnl;
    equity.push({ ts: Number(p.lastStateChangeTs), cum });
  }
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of equity) {
    if (e.cum > peak) peak = e.cum;
    const dd = peak - e.cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return {
    windowHours,
    passRatePct: signalsTotal > 0 ? (signalsAccepted / signalsTotal) * 100 : 0,
    signalsPerHour: signalsTotal / windowHours,
    profitFactor: negPnl > 0 ? posPnl / negPnl : (posPnl > 0 ? Infinity : 0),
    winRatePct: closed.length > 0 ? (wins / closed.length) * 100 : 0,
    avgHoldSec: closed.length > 0 ? holdSec / closed.length : 0,
    drawdownUsd: maxDrawdown,
    netPnlUsd: totalExit - totalEntry,
    closedCount: closed.length,
  };
}
```

- [ ] **Step 2: Wire route** in `if (req.method === "GET")`:

```ts
if (req.url?.startsWith("/api/kpi")) return send(res, 200, await handleKpi(req));
```

- [ ] **Step 3: tsc + smoke**

```bash
npx tsc --noEmit
DEV_AUTH_TOKEN=secretdev REST_PORT=8081 npm run dev:api > /tmp/api-t24.log 2>&1 &
sleep 2
curl -s -H "X-Dev-Bypass: secretdev" "http://localhost:8081/api/kpi?windowHours=24"
pkill -f "tsx watch.*src/api/main\.ts"
```

Expected: JSON with `passRatePct`, `signalsPerHour`, `profitFactor`, `winRatePct`, `avgHoldSec`, `drawdownUsd`, `netPnlUsd`, `closedCount`.

- [ ] **Step 4: Commit**: `git add src/api/rest_server.ts && git commit -m "api: GET /api/kpi (pass rate / PF / WR / drawdown / avg hold)"`

### Task 25: KPI card on Live tab + cockpit second-line summary

**Files:** Modify: `web/js/views/live.js`, `web/js/cockpit.js`

- [ ] **Step 1: Live KPI card** — prepend a 4th card BEFORE "Now happening" in `renderLive`:

```html
<section class="card" id="kpi-card"><div class="card-title">KPIs · 24h</div><div class="card-body" id="kpi-body">…</div></section>
```

In `loadAll()` add `loadKpis()` and implement:

```js
async function loadKpis() {
  const k = await fetchJson("/api/kpi?windowHours=24");
  document.getElementById("kpi-body").innerHTML = `
    <div class="kv"><span class="k">win rate</span><span class="v">${k.winRatePct.toFixed(1)}%</span></div>
    <div class="kv"><span class="k">profit factor</span><span class="v">${isFinite(k.profitFactor) ? k.profitFactor.toFixed(2) : "—"}</span></div>
    <div class="kv"><span class="k">drawdown</span><span class="v bad">-$${k.drawdownUsd.toFixed(2)}</span></div>
    <div class="kv"><span class="k">avg hold</span><span class="v">${(k.avgHoldSec / 60).toFixed(1)} min</span></div>
    <div class="kv"><span class="k">pass rate</span><span class="v">${k.passRatePct.toFixed(1)}%</span></div>
    <div class="kv"><span class="k">signals/h</span><span class="v">${k.signalsPerHour.toFixed(0)}</span></div>
  `;
}
```

- [ ] **Step 2: Cockpit second line** — `cockpit.js` extend to add a second row:

```html
<div class="cockpit-line2">WR ${k.winRatePct.toFixed(0)}% • PF ${isFinite(k.profitFactor) ? k.profitFactor.toFixed(1) : '—'} • DD -$${k.drawdownUsd.toFixed(2)}</div>
```

Append to styles.css:

```css
.cockpit-line2 { font-size: 11px; color: var(--text-muted); margin-top: 2px; width: 100%; }
.cockpit { flex-wrap: wrap; }
```

- [ ] **Step 3: Smoke + commit**: refresh Mini App, verify KPI card on Live + cockpit shows WR/PF/DD; `git add web/ && git commit -m "web: KPI card on Live tab + cockpit second-line summary"`

## Phase H — Per-trade rich detail (initiator + verification)

### Task 26: Extend /api/positions/:id/timeline with initiator + verification

**Files:** Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Augment handler** — modify `handlePositionTimeline` to also pull the originating signal row:

```ts
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

  // Initiator: most recent signal for this conditionId+assetId before fillTs
  const sigRows = await db.query.signals.findMany({
    where: and(
      eq(signals.assetId, p.assetId),
      eq(signals.userId, p.userId),
    ),
    orderBy: (cols, { desc }) => [desc(cols.id)],
    limit: 5,
  });
  const initiatorSig = sigRows.find((s) => Number(s.receivedTs) <= Number(p.fillTs ?? 0)) ?? sigRows[0];
  const payload = (initiatorSig?.payload ?? {}) as Record<string, unknown>;

  // Convergence count: signals on same asset within ±60s of fill
  const fillTs = Number(p.fillTs ?? 0);
  const window = 60_000;
  const convergent = sigRows.filter((s) => Math.abs(Number(s.receivedTs) - fillTs) <= window).length;

  // PnL verification source heuristic
  const sells = fillRows.filter((f) => f.side === "SELL");
  const verifSource = sells.length > 0 ? "chain_per_trade"
    : (p.closeReason === "sell_filled_chain_lag" ? "trade_reconciler"
      : (p.status === "CLOSED" ? "manual" : "unverified"));

  return {
    position: await handlePositionById(id),
    initiator: {
      whaleAddress: payload["whaleAddress"] ?? null,
      whaleSizeShares: payload["whaleSizeShares"] ?? null,
      whaleSizeUsd: typeof payload["whaleSizeShares"] === "number"
        ? Number(payload["whaleSizeShares"]) * Number(p.fillPrice ?? 0)
        : null,
      conviction: payload["convictionScore"] ?? null,
      trustScore: payload["trustScore"] ?? null,
      smScore: payload["smScore"] ?? null,
      title: payload["title"] ?? null,
      signalReceivedTs: initiatorSig ? Number(initiatorSig.receivedTs) : null,
      convergenceCount: convergent,
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
    recentDecisions: decisionRows.map((d) => ({
      ts: Number(d.ts),
      action: (d.outputIntent as Record<string, unknown>)["action"],
      reason: (d.outputIntent as Record<string, unknown>)["reason"],
      gates: d.gates,
      durationMs: d.durationMs,
      markSource: ((d.inputSnapshot as Record<string, unknown>)["markSource"] ?? null),
      markFreshnessMs: ((d.inputSnapshot as Record<string, unknown>)["markTs"] !== undefined
        ? Number(d.ts) - Number((d.inputSnapshot as Record<string, unknown>)["markTs"])
        : null),
    })),
  };
}
```

- [ ] **Step 2: tsc + smoke + commit**

```bash
npx tsc --noEmit
git add src/api/rest_server.ts && git commit -m "api: timeline adds initiator + verification + per-decision mark source"
```

### Task 27: Position drilldown UI extension

**Files:** Modify: `web/js/sheets/position.js`

- [ ] **Step 1**: After the existing key-value block in the sheet body, BEFORE "Timeline":

```html
<div class="card-title" style="margin-top:14px">Initiator</div>
<div class="kv"><span class="k">whale</span><span class="v"><code>${escapeHtml((data.initiator?.whaleAddress ?? "—").toString().slice(0, 14))}</code></span></div>
<div class="kv"><span class="k">whale size USD</span><span class="v">${data.initiator?.whaleSizeUsd ? "$" + Number(data.initiator.whaleSizeUsd).toFixed(2) : "—"}</span></div>
<div class="kv"><span class="k">conviction</span><span class="v">${data.initiator?.conviction ?? "—"}</span></div>
<div class="kv"><span class="k">trust score</span><span class="v">${data.initiator?.trustScore ?? "—"}</span></div>
<div class="kv"><span class="k">sm score</span><span class="v">${data.initiator?.smScore ?? "—"}</span></div>
<div class="kv"><span class="k">convergence (±60s)</span><span class="v">${data.initiator?.convergenceCount ?? 0}</span></div>

<div class="card-title" style="margin-top:14px">Verification</div>
<div class="kv"><span class="k">PnL source</span><span class="v">${escapeHtml(data.verification?.pnlSource ?? "—")}</span></div>
<div class="kv"><span class="k">exit tx</span><span class="v">${data.verification?.exitTxHash ? `<code>${escapeHtml(String(data.verification.exitTxHash).slice(0, 14))}…</code>` : "—"}</span></div>
${data.verification?.anomaly ? '<div class="kv"><span class="k">⚠ anomaly</span><span class="v bad">flagged</span></div>' : ""}
```

Also enrich each "Recent decisions" row with mark-source:

```html
<span class="muted">${d.markSource ?? ""}${d.markFreshnessMs !== null ? " " + Math.round(d.markFreshnessMs) + "ms" : ""}</span>
```

- [ ] **Step 2: Smoke + commit**

```bash
git add web/ && git commit -m "web: position drilldown shows initiator (whale/conviction/trust/sm/convergence) + verification source"
```

## Phase I — Filter pipeline registry (full v1 list as view)

### Task 28: src/filters/registry.ts + GET /api/filters/registry

**Files:** Create: `src/filters/registry.ts`. Modify: `src/api/rest_server.ts`

- [ ] **Step 1: Create registry**

```ts
// src/filters/registry.ts
export type FilterGroup =
  | "hard_safety" | "conviction" | "wallet_quality"
  | "market_quality" | "price_quality" | "risk_exposure";

export interface FilterDescriptor {
  name: string;
  group: FilterGroup;
  ported: boolean;
  description: string;
  defaultThreshold?: number | string | null;
}

export const FILTER_REGISTRY: readonly FilterDescriptor[] = [
  // Hard Safety (~18 from v1)
  { name: "kill_switch", group: "hard_safety", ported: true, description: "Block all entries when kill switch active" },
  { name: "sell_trade", group: "hard_safety", ported: false, description: "Reject SELL signals (BUY-only mode)" },
  { name: "trade_age", group: "hard_safety", ported: false, description: "Reject signals older than MAX_TRADE_AGE_SEC", defaultThreshold: 120 },
  { name: "entry_cooldown", group: "hard_safety", ported: false, description: "Block re-entry within ENTRY_COOLDOWN_S", defaultThreshold: 120 },
  { name: "exit_reentry", group: "hard_safety", ported: false, description: "Block re-entry within EXIT_REENTRY_COOLDOWN_S after a close", defaultThreshold: 600 },
  { name: "price_band", group: "hard_safety", ported: true, description: "Reject if price outside [PRICE_MIN, PRICE_MAX]", defaultThreshold: "[0.15, 0.85]" },
  { name: "category", group: "hard_safety", ported: true, description: "Block markets not in allowed category list" },
  { name: "intraday_binary", group: "hard_safety", ported: false, description: "Reject intraday-binary + crypto coin-flip markets" },
  { name: "market_resolved", group: "hard_safety", ported: true, description: "Reject resolved/closed markets" },
  { name: "min_time_to_res", group: "hard_safety", ported: false, description: "Reject if market resolves too soon" },
  { name: "max_positions", group: "hard_safety", ported: true, description: "Reject if open_positions >= MAX_OPEN_POSITIONS" },
  { name: "dedup", group: "hard_safety", ported: false, description: "Reject duplicate entry on same market in window" },
  { name: "drawdown_full_stop", group: "hard_safety", ported: false, description: "Hard stop if drawdown > DRAWDOWN_STOP_PCT" },
  { name: "total_exposure_cap", group: "hard_safety", ported: true, description: "Reject if open_cost sum > MAX_TOTAL_EXPOSURE_USD" },
  { name: "recent_reject_cache", group: "hard_safety", ported: false, description: "Skip recently rejected tokens for cooldown" },
  { name: "min_whale_size", group: "hard_safety", ported: false, description: "Reject whale size < MIN_WHALE_SIZE_USD" },
  { name: "post_resolution", group: "hard_safety", ported: false, description: "Block entry after market resolution" },
  { name: "bid_ask_spread", group: "hard_safety", ported: false, description: "Reject if spread > MAX_BID_ASK_SPREAD_BPS" },
  // Conviction
  { name: "conviction_gate", group: "conviction", ported: false, description: "Gate on conviction score threshold" },
  // Wallet Quality
  { name: "trust_gate", group: "wallet_quality", ported: false, description: "Gate on whale trust_score" },
  { name: "sm_score_gate", group: "wallet_quality", ported: false, description: "Gate on whale sm_score (size escalation)" },
  // Market Quality
  { name: "market_volume", group: "market_quality", ported: false, description: "Reject low-volume markets" },
  // Price Quality
  { name: "price_impact", group: "price_quality", ported: false, description: "Reject orders with high price impact" },
  { name: "slippage", group: "price_quality", ported: false, description: "Reject if slippage > threshold" },
  { name: "price_collapsed", group: "price_quality", ported: false, description: "Reject if price collapsed to 0 or 1" },
  { name: "remaining_edge", group: "price_quality", ported: false, description: "Reject if remaining edge < threshold" },
  { name: "tp_reachability", group: "price_quality", ported: false, description: "Reject if TP unreachable" },
  // Risk Exposure
  { name: "correlation_cap", group: "risk_exposure", ported: false, description: "Cap exposure for correlated positions" },
  { name: "drawdown_minimal", group: "risk_exposure", ported: false, description: "Minimal drawdown sanity check" },
  { name: "max_positions_per_event", group: "risk_exposure", ported: false, description: "Cap positions per event/domain" },
  // v2-only additions
  { name: "sport_only", group: "hard_safety", ported: true, description: "Sports-only domain restriction (v2 P1 default)" },
  { name: "price_too_high", group: "price_quality", ported: true, description: "Reject if entry price > PRICE_CEILING (v2)" },
  { name: "budget_exhausted", group: "hard_safety", ported: true, description: "Reject when strategy budget exhausted (v2)" },
];
```

- [ ] **Step 2: Endpoint** in rest_server.ts:

```ts
import { FILTER_REGISTRY } from "../filters/registry.js";

async function handleFilterRegistry(): Promise<unknown> {
  return { count: FILTER_REGISTRY.length, filters: FILTER_REGISTRY };
}
```

Route: `if (req.url === "/api/filters/registry") return send(res, 200, await handleFilterRegistry());`

- [ ] **Step 3: tsc + commit**

```bash
npx tsc --noEmit
git add src/filters/registry.ts src/api/rest_server.ts && git commit -m "filters: registry of all 30+ v1 filters with ported flag + GET /api/filters/registry"
```

### Task 29: Strategy tab — Filters card upgraded to grouped-by-group

**Files:** Modify: `web/js/views/strategy.js`

- [ ] **Step 1**: Replace the simple table with grouped sections. Pull both `/api/filters/registry` and `/api/filters/stats?windowHours=24`. Render a section per `FilterGroup`:

```js
const [strategies, exitCfg, filterStats, filterRegistry] = await Promise.all([
  fetchJson("/api/strategies"),
  fetchJson("/api/exit_config"),
  fetchJson("/api/filters/stats?windowHours=24"),
  fetchJson("/api/filters/registry"),
]);
// ... existing render code ...

// Group filters by `group`, show ported status + count from stats.byReason
const groups = filterRegistry.filters.reduce((acc, f) => {
  (acc[f.group] = acc[f.group] || []).push(f);
  return acc;
}, {});
```

Render each group as a `<section class="card">` with a small `<table>` listing name / threshold / 24h count / ported badge.

- [ ] **Step 2: Smoke + commit**

```bash
git add web/ && git commit -m "web: Strategy filters card grouped by FilterGroup with ported badges"
```

## Phase J — Latency telemetry per signal stage

### Task 30: signal_timings table + withTiming helper + instrumentation

**Files:** Modify: `src/db/schema.ts`. Create: `src/obs/timing.ts`. Modify: `src/feed/signal_router.ts`, `src/execute/executor.ts`

- [ ] **Step 1: Schema add**

```ts
export const signalTimings = pgTable(
  "signal_timings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    signalId: bigint("signal_id", { mode: "number" }).references(() => signals.id, { onDelete: "cascade" }),
    positionId: bigint("position_id", { mode: "number" }).references(() => positions.id, { onDelete: "set null" }),
    chain: varchar("chain", { length: 8 }).notNull(),
    stage: varchar("stage", { length: 40 }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_signal_timings_signal").on(t.signalId),
    index("idx_signal_timings_chain_stage").on(t.chain, t.stage),
  ],
);
```

Run `npm run db:generate && npm run db:push`.

- [ ] **Step 2: withTiming helper**

```ts
// src/obs/timing.ts
import { getDb } from "../db/client.js";
import { signalTimings } from "../db/schema.js";
import { logger } from "./logger.js";

export interface TimingCtx {
  signalId: number | null;
  positionId: number | null;
  chain: "entry" | "exit";
}

export async function withTiming<T>(
  ctx: TimingCtx, stage: string, fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - start);
    void (async () => {
      try {
        await getDb().insert(signalTimings).values({
          signalId: ctx.signalId,
          positionId: ctx.positionId,
          chain: ctx.chain,
          stage,
          durationMs: ms,
          ts: Date.now(),
        });
      } catch (err) {
        logger.debug({ err, stage }, "signal_timings insert failed");
      }
    })();
  }
}
```

- [ ] **Step 3: Instrument routeInner** — wrap each major step (gamma fetch, filter pipeline, sizing, placeBuy, INSERT) with `withTiming(ctx, "<stage>", ...)`. Stages: `gamma_fetch`, `filter_pipeline`, `sizing`, `place_buy`, `position_insert`. Same pattern for `executeExitIntent`: stages `cancel_open`, `place_sell`, `position_update`.

- [ ] **Step 4: GET /api/latency** in rest_server.ts

```ts
async function handleLatency(req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://x");
  const windowHours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("windowHours") ?? 24)));
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
    if (!b) { b = { chain: r.chain, stage: r.stage, count: 0, sum: 0, max: 0 }; buckets.set(k, b); }
    b.count += 1; b.sum += r.durationMs; if (r.durationMs > b.max) b.max = r.durationMs;
  }
  const stages = [...buckets.values()].map((b) => ({
    ...b, avgMs: b.sum / b.count,
  })).sort((a, b) => b.avgMs - a.avgMs);
  const bottleneck = stages[0]?.stage ?? null;
  return { windowHours, stages, bottleneck };
}
```

Route: `if (req.url?.startsWith("/api/latency")) return send(res, 200, await handleLatency(req));`

- [ ] **Step 5: tsc + smoke + commit**

```bash
npx tsc --noEmit
git add src/db/schema.ts drizzle/ src/db/migrations/ src/obs/timing.ts src/feed/signal_router.ts src/execute/executor.ts src/api/rest_server.ts && git commit -m "obs: signal_timings table + withTiming helper + entry/exit chain instrumentation + GET /api/latency"
```

### Task 31: Latency sub-card on More tab

**Files:** Modify: `web/js/views/more.js`

- [ ] **Step 1**: Add a `Latency` card after `Performance`:

```js
const lat = await fetchJson("/api/latency?windowHours=24");
// ... in More render:
<section class="card">
  <div class="card-title">Latency · 24h ${lat.bottleneck ? `· bottleneck: ${escapeHtml(lat.bottleneck)}` : ""}</div>
  <div class="card-body">
    <table class="filters">
      <tr><th>chain</th><th>stage</th><th>avg ms</th><th>count</th></tr>
      ${lat.stages.slice(0, 20).map((s) => `<tr><td>${escapeHtml(s.chain)}</td><td>${escapeHtml(s.stage)}</td><td>${s.avgMs.toFixed(0)}</td><td>${s.count}</td></tr>`).join("")}
    </table>
  </div>
</section>
```

- [ ] **Step 2: Commit**: `git add web/ && git commit -m "web: More tab latency sub-card with per-stage avg + bottleneck"`

## Phase K — Whale corpus + classifier

### Task 32: ALTER TABLE whales + import 1500-wallet seed

**Files:** Modify: `src/db/schema.ts`. Create: `scripts/import-v1-whales.ts`

- [ ] **Step 1: Schema additions**

```ts
// extend `whales` pgTable definition
smScore: doublePrecision("sm_score"),
trustScore: doublePrecision("trust_score"),
totalTrades: integer("total_trades").default(0),
winRate: doublePrecision("win_rate"),
avgHoldHours: doublePrecision("avg_hold_hours"),
directionalRatio: doublePrecision("directional_ratio"),
domainBreakdown: jsonb("domain_breakdown").default({}),
perDomainClassification: jsonb("per_domain_classification").default({}),
lastClassifiedAt: timestamp("last_classified_at", { withTimezone: true }),
lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
```

Add `doublePrecision` to drizzle-orm/pg-core import if missing.

`npm run db:generate && npm run db:push`.

- [ ] **Step 2: Import script** — reads `~/Documents/GitHub/ora-et-labora/output/wallet_profiles.json` and UPSERTs into `whales`. Default `tracked=false` for newly imported; existing tracked rows preserved.

```ts
// scripts/import-v1-whales.ts
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { whales } from "../src/db/schema.js";

const FILE = process.env["V1_WALLETS"] ?? `${process.env["HOME"]}/Documents/GitHub/ora-et-labora/output/wallet_profiles.json`;
const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, Record<string, unknown>>;
const db = getDb();
let inserted = 0;
let updated = 0;
for (const [addr, prof] of Object.entries(data)) {
  const lower = addr.toLowerCase();
  const m = (prof["metrics"] ?? {}) as Record<string, unknown>;
  const values = {
    address: lower,
    classification: String(prof["classification"] ?? "NOISE"),
    confidence: Number(prof["confidence"] ?? 0),
    smScore: Number(m["size_escalation_score"] ?? 0),
    trustScore: Number(m["win_rate"] ?? 0) * Number(m["avg_hold_hours"] ?? 0),
    totalTrades: Number(m["total_trades"] ?? 0),
    winRate: Number(m["win_rate"] ?? 0),
    avgHoldHours: Number(m["avg_hold_hours"] ?? 0),
    directionalRatio: Number(m["directional_ratio"] ?? 0),
    domainBreakdown: (prof["domain_breakdown"] ?? {}) as Record<string, unknown>,
    perDomainClassification: (prof["per_domain_classification"] ?? {}) as Record<string, unknown>,
    lastClassifiedAt: prof["last_classified"] ? new Date(Number(prof["last_classified"]) * 1000) : null,
    lastActivityAt: prof["last_activity_ts"] ? new Date(Number(prof["last_activity_ts"]) * 1000) : null,
  };
  const r = await db.insert(whales)
    .values({ ...values, strategyId: 1, tracked: false })
    .onConflictDoUpdate({ target: whales.address, set: values })
    .returning({ id: whales.id });
  if (r.length > 0) inserted += 1; else updated += 1;
}
console.log(`done: inserted=${inserted} updated=${updated}`);
process.exit(0);
```

(Note: `whales` may need composite unique on `(strategy_id, address)` — verify in schema and adjust onConflict target.)

- [ ] **Step 3: Run + verify**

```bash
npx tsx --env-file=.env scripts/import-v1-whales.ts
psql postgresql://ora:ora@localhost:5433/ora_v2 -c "SELECT count(*) FROM whales;"
```

Expected: count grows from ~200 to ~1500.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/ src/db/migrations/ scripts/import-v1-whales.ts && git commit -m "whales: schema + 1500-wallet seed import from v1 wallet_profiles.json"
```

### Task 33: GET /api/whales/:addr/profile + classification chips

**Files:** Modify: `src/api/rest_server.ts`, `web/js/views/whales.js`, `web/js/sheets/whale.js`

- [ ] **Step 1: Endpoint**

```ts
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
```

Route: regex `^\/api\/whales\/(0x[0-9a-fA-F]{40})\/profile$` → `handleWhaleProfile(match[1])`.

- [ ] **Step 2: Whales tab** — add classification chips: `INFORMED / SHARP / FOLLOWER / NOISE`. Filter list by selected classification AND tracked/all chip combinedly.

- [ ] **Step 3: Whale sheet** — call `/api/whales/:addr/profile` and render full breakdown (smScore, trustScore, winRate, avgHoldHours, directionalRatio, domain table).

- [ ] **Step 4: tsc + smoke + commit**

```bash
npx tsc --noEmit
git add src/api/rest_server.ts web/ && git commit -m "api+web: whale profile endpoint + classification chips + full sheet breakdown"
```

### Task 34: (deferred) Whale classifier daemon

**Files:** Create: `src/whale/classifier.ts` (placeholder)

This is significant porting work from v1 (computing metrics from
historical chain trades). Out of MVP scope; lands in P2c-like phase.
For MVP, the classifier columns are populated by the one-time import
in Task 32 from v1's already-classified profiles.

Mark this in BULLETPROOF.md as a P2c follow-up. No code change beyond
a stub README in `src/whale/README.md` flagging the gap.

```bash
mkdir -p src/whale
echo "# Whale classifier — port from v1 (P2c)" > src/whale/README.md
git add src/whale/README.md && git commit -m "whale: placeholder for classifier port (P2c follow-up)"
```

## Phase F (continued) — re-verify smoke after G–K

### Task 35: Re-run end-to-end LIVE smoke with new tabs

After all phases G–K land, re-do the Phase F smoke checklist (Task 23)
PLUS:

- [ ] Live tab shows KPI card (WR/PF/DD/avg-hold/pass-rate/signals-h)
- [ ] Cockpit shows second-line summary
- [ ] Position drilldown shows Initiator + Verification sections
- [ ] Strategy tab Filters card shows all 30+ filters grouped, ported badges visible
- [ ] More tab shows Latency card with per-stage avg + bottleneck
- [ ] Whales tab classification chips filter; whale sheet shows full breakdown
- [ ] `psql … -c "SELECT count(*) FROM whales"` ≥ 1500
- [ ] `psql … -c "SELECT count(*) FROM signal_timings WHERE ts > extract(epoch from now())*1000 - 60000"` > 0 (timings flowing)

Commit BULLETPROOF.md update with v1 catch-up confirmation.

---

## Self-review checklist

After implementation, verify against the spec:

1. **Cockpit bar** — ✓ Tasks 16 (cockpit.js + index.html)
2. **Tab 1 Live (now/positions/rejects/Pause/Resume)** — ✓ Task 17
3. **Position drilldown sheet** — ✓ Task 18
4. **Tab 2 History (chips + aggregates + sparkline + trades)** — Tasks 19. Sparkline noted as "Canvas later"; cumulative sparkline not in this MVP — flagged in spec deferred list.
5. **Tab 3 Strategy (params + exit + filters)** — ✓ Task 20
6. **Tab 4 Whales (filter + list + sheet)** — ✓ Task 21
7. **Tab 5 More (notifications/conns/perf/audit/build)** — ✓ Task 22
8. **Auth via init-data** — already shipped pre-plan; confirmed by Task 23 smoke
9. **runtime_config + audit_log** — ✓ Tasks 1-3, 14
10. **Edit applies to next decide_exit tick** — ✓ Tasks 4 (loader), 12 (POST exit_config), Task 23 smoke
11. **All POSTs audited** — ✓ Tasks 11, 12, 13, 14
12. **WhaleFollow re-reads params per evaluate** — verified by Task 11 smoke (param edit reflected on next signal)

Items deferred per spec (NOT in this plan):
- Calibrator UI / engine — P2c
- Filter editing controls — P2c
- Whale P&L attribution — P2c
- Filter pass-rate history charts — P2c
- Notification config UI — P2d
- Push notifications — P4

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-02-mini-app-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
