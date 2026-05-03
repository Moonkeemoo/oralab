import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// =============================================================================
// USERS + WALLETS
//   P1: row id=1 = Taras (env-driven). Schema multi-user-shaped from Day 1
//   so P3c migration is just adding rows + auth, not altering existing tables.
// =============================================================================

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).unique(),
    telegramUsername: varchar("telegram_username", { length: 64 }),
    role: varchar("role", { length: 16 }).notNull().default("user"), // user | admin
    locale: varchar("locale", { length: 8 }).notNull().default("en"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_users_telegram_chat_id").on(t.telegramChatId)],
);

export const walletModeValues = ["env", "byo", "custodial"] as const;
export type WalletMode = (typeof walletModeValues)[number];

export const wallets = pgTable(
  "wallets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "restrict" }),
    address: varchar("address", { length: 42 }).notNull(),
    mode: varchar("mode", { length: 16 }).notNull(), // WalletMode
    signatureType: integer("signature_type").notNull().default(1), // 1=proxy 2=eoa 3=erc1271
    encryptedPrivateKey: text("encrypted_private_key"), // null in P1 (env mode)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_wallets_user_address").on(t.userId, t.address),
    index("idx_wallets_user").on(t.userId),
  ],
);

// =============================================================================
// STRATEGIES + WHALES + STRATEGY_FILTERS
// =============================================================================

export const strategyKindValues = [
  "whale_follow",
  "sports_ws_reactor",
  "sports_pre_event",
] as const;
export type StrategyKindDb = (typeof strategyKindValues)[number];

export const strategies = pgTable(
  "strategies",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    dryRun: boolean("dry_run").notNull().default(true),
    params: jsonb("params").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_strategies_user_name").on(t.userId, t.name)],
);

export const whaleClassValues = ["NOISE", "SNIPER", "INFORMED", "UNCLASSIFIED"] as const;
export type WhaleClass = (typeof whaleClassValues)[number];

export const whales = pgTable(
  "whales",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    strategyId: bigint("strategy_id", { mode: "number" })
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    address: varchar("address", { length: 42 }).notNull(),
    label: varchar("label", { length: 64 }),
    classification: varchar("classification", { length: 32 }).notNull().default("UNCLASSIFIED"),
    confidence: doublePrecision("confidence").notNull().default(0),
    tracked: boolean("tracked").notNull().default(false),
    smScore: doublePrecision("sm_score"),
    trustScore: doublePrecision("trust_score"),
    totalTrades: integer("total_trades").default(0),
    winRate: doublePrecision("win_rate"),
    avgHoldHours: doublePrecision("avg_hold_hours"),
    directionalRatio: doublePrecision("directional_ratio"),
    domainBreakdown: jsonb("domain_breakdown").default({}),
    perDomainClassification: jsonb("per_domain_classification").default({}),
    sportsDomains: jsonb("sports_domains").notNull().default({}),
    chainMetrics: jsonb("chain_metrics").notNull().default({}),
    lastClassifiedAt: timestamp("last_classified_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_whales_strategy_address").on(t.strategyId, t.address),
    index("idx_whales_tracked").on(t.tracked),
  ],
);

export const strategyFilters = pgTable(
  "strategy_filters",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    strategyId: bigint("strategy_id", { mode: "number" })
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    filterName: varchar("filter_name", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    params: jsonb("params").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_strategy_filters_strat_name").on(t.strategyId, t.filterName)],
);

// =============================================================================
// MARKETS — Polymarket metadata cache
// =============================================================================

export const markets = pgTable(
  "markets",
  {
    conditionId: varchar("condition_id", { length: 66 }).primaryKey(),
    slug: varchar("slug", { length: 256 }),
    question: text("question"),
    negRisk: boolean("neg_risk").notNull(),
    tickSize: doublePrecision("tick_size").notNull(),
    minOrderSize: doublePrecision("min_order_size").notNull(),
    makerFeeBps: integer("maker_fee_bps").notNull().default(0),
    takerFeeBps: integer("taker_fee_bps").notNull().default(0),
    endDateTs: bigint("end_date_ts", { mode: "number" }),
    sportLeague: varchar("sport_league", { length: 32 }),
    raw: jsonb("raw").notNull().default({}),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_markets_end_date").on(t.endDateTs)],
);

// =============================================================================
// SIGNALS — incoming events from feeds
// =============================================================================

export const signalSourceValues = ["whale_chain", "whale_ws", "sports_ws", "manual"] as const;
export type SignalSourceDb = (typeof signalSourceValues)[number];

export const signals = pgTable(
  "signals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    strategyId: bigint("strategy_id", { mode: "number" })
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 32 }).notNull(),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),
    assetId: varchar("asset_id", { length: 96 }).notNull(),
    side: varchar("side", { length: 4 }).notNull(),
    priceHint: doublePrecision("price_hint"),
    volumeUsdHint: doublePrecision("volume_usd_hint"),
    payload: jsonb("payload").notNull().default({}),
    accepted: boolean("accepted"),
    rejectReason: varchar("reject_reason", { length: 64 }),
    receivedTs: bigint("received_ts", { mode: "number" }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_signals_user_received").on(t.userId, t.receivedTs),
    index("idx_signals_strategy_received").on(t.strategyId, t.receivedTs),
    index("idx_signals_condition").on(t.conditionId),
  ],
);

// =============================================================================
// POSITIONS — 7-state machine (see src/types/position.ts)
// =============================================================================

export const positions = pgTable(
  "positions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    walletId: bigint("wallet_id", { mode: "number" })
      .notNull()
      .references(() => wallets.id, { onDelete: "restrict" }),
    strategyId: bigint("strategy_id", { mode: "number" })
      .notNull()
      .references(() => strategies.id, { onDelete: "restrict" }),
    signalId: bigint("signal_id", { mode: "number" }).references(() => signals.id, {
      onDelete: "set null",
    }),
    conditionId: varchar("condition_id", { length: 66 }).notNull(),
    assetId: varchar("asset_id", { length: 96 }).notNull(),
    side: varchar("side", { length: 4 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    mode: varchar("mode", { length: 8 }).notNull().default("DRY"),
    shares: doublePrecision("shares").notNull().default(0),
    fillPrice: doublePrecision("fill_price").notNull().default(0),
    peakPrice: doublePrecision("peak_price").notNull().default(0),
    fillTs: bigint("fill_ts", { mode: "number" }),
    lastStateChangeTs: bigint("last_state_change_ts", { mode: "number" }).notNull(),
    trailArmed: boolean("trail_armed").notNull().default(false),
    sweepCount: integer("sweep_count").notNull().default(0),
    entryCostUsd: doublePrecision("entry_cost_usd").notNull().default(0),
    realizedPnlUsd: doublePrecision("realized_pnl_usd"),
    closeReason: varchar("close_reason", { length: 64 }),
    closeTxHash: varchar("close_tx_hash", { length: 66 }),
    sportsHint: jsonb("sports_hint").$type<{
      type: "game_ended";
      gameId: string;
      score: string;
      league: string;
      at: number;
    } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_positions_user_status").on(t.userId, t.status),
    index("idx_positions_condition_asset").on(t.conditionId, t.assetId),
    index("idx_positions_mode_status").on(t.mode, t.status),
    uniqueIndex("uq_positions_open_per_asset")
      .on(t.userId, t.assetId)
      .where(sql`status IN ('PENDING','FILLED','OPEN','EXITING','RESOLVED','FROZEN')`),
  ],
);

// =============================================================================
// ORDERS — CLOB order lifecycle (FOK BUY, GTD SELL, etc.)
// =============================================================================

export const orderModeValues = ["FOK", "FAK", "GTD", "GTC"] as const;
export type OrderMode = (typeof orderModeValues)[number];

export const orders = pgTable(
  "orders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    positionId: bigint("position_id", { mode: "number" }).references(() => positions.id, {
      onDelete: "set null",
    }),
    mode: varchar("mode", { length: 8 }).notNull(),
    side: varchar("side", { length: 4 }).notNull(),
    price: doublePrecision("price").notNull(),
    size: doublePrecision("size").notNull(),
    expirationTs: bigint("expiration_ts", { mode: "number" }),
    clientOrderId: varchar("client_order_id", { length: 66 }).notNull(),
    clobOrderId: varchar("clob_order_id", { length: 66 }),
    status: varchar("status", { length: 24 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    errorCode: varchar("error_code", { length: 64 }),
    rawRequest: jsonb("raw_request").notNull().default({}),
    rawResponse: jsonb("raw_response").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_orders_client_id").on(t.clientOrderId),
    index("idx_orders_position").on(t.positionId),
    index("idx_orders_status").on(t.status),
  ],
);

// =============================================================================
// FILLS — on-chain fill events (replaces ghost-verify state machine)
// =============================================================================

export const fills = pgTable(
  "fills",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    positionId: bigint("position_id", { mode: "number" }).references(() => positions.id, {
      onDelete: "set null",
    }),
    orderId: bigint("order_id", { mode: "number" }).references(() => orders.id, {
      onDelete: "set null",
    }),
    txHash: varchar("tx_hash", { length: 66 }).notNull(),
    side: varchar("side", { length: 4 }).notNull(),
    shares: doublePrecision("shares").notNull(),
    price: doublePrecision("price").notNull(),
    feeUsd: doublePrecision("fee_usd").notNull().default(0),
    ts: bigint("ts", { mode: "number" }).notNull(),
    raw: jsonb("raw").notNull().default({}),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_fills_tx_hash_position").on(t.txHash, t.positionId),
    index("idx_fills_position_ts").on(t.positionId, t.ts),
  ],
);

// =============================================================================
// MARKS — current + historical mark prices (per asset, time-series)
// =============================================================================

export const marks = pgTable(
  "marks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    assetId: varchar("asset_id", { length: 96 }).notNull(),
    src: varchar("src", { length: 24 }).notNull(),
    mark: doublePrecision("mark").notNull(),
    bid: doublePrecision("bid"),
    ask: doublePrecision("ask"),
    peak: doublePrecision("peak"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => [index("idx_marks_asset_ts").on(t.assetId, t.ts)],
);

// =============================================================================
// LIFECYCLE_EVENTS — append-only audit log
// =============================================================================

export const lifecycleEvents = pgTable(
  "lifecycle_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    positionId: bigint("position_id", { mode: "number" }).references(() => positions.id, {
      onDelete: "set null",
    }),
    event: varchar("event", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_lifecycle_user_ts").on(t.userId, t.ts),
    index("idx_lifecycle_position_ts").on(t.positionId, t.ts),
    index("idx_lifecycle_event").on(t.event),
  ],
);

// =============================================================================
// KILL_SWITCHES — global + per-user/strategy stops
// =============================================================================

export const killSwitchScopeValues = ["global", "user", "strategy"] as const;
export type KillSwitchScope = (typeof killSwitchScopeValues)[number];

export const killSwitches = pgTable(
  "kill_switches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scope: varchar("scope", { length: 16 }).notNull(),
    scopeId: bigint("scope_id", { mode: "number" }), // null when scope=global
    active: boolean("active").notNull().default(true),
    reason: text("reason"),
    setByUserId: bigint("set_by_user_id", { mode: "number" }).references(() => users.id),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_kill_switches_active").on(t.active),
    index("idx_kill_switches_scope").on(t.scope, t.scopeId),
  ],
);

// =============================================================================
// DECISIONS (P1.5) + SPORTS_EVENTS (P1.5)
//   Schema present from Day 1; populated starting P1.5.
// =============================================================================

export const decisions = pgTable(
  "decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    positionId: bigint("position_id", { mode: "number" }).references(() => positions.id, {
      onDelete: "set null",
    }),
    signalId: bigint("signal_id", { mode: "number" }).references(() => signals.id, {
      onDelete: "set null",
    }),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    outputIntent: jsonb("output_intent").notNull(),
    gates: jsonb("gates").notNull().default([]),
    durationMs: integer("duration_ms"),
    ts: bigint("ts", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_decisions_position_ts").on(t.positionId, t.ts),
    index("idx_decisions_user_ts").on(t.userId, t.ts),
  ],
);

export const sportsEvents = pgTable(
  "sports_events",
  {
    gameId: varchar("game_id", { length: 64 }).primaryKey(),
    league: varchar("league", { length: 32 }).notNull(),
    homeTeam: varchar("home_team", { length: 128 }),
    awayTeam: varchar("away_team", { length: 128 }),
    score: jsonb("score").notNull().default({}),
    period: varchar("period", { length: 32 }),
    status: varchar("status", { length: 32 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    raw: jsonb("raw").notNull().default({}),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_sports_events_league").on(t.league),
    index("idx_sports_events_status").on(t.status),
  ],
);

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

// =============================================================================
// SIGNAL_TIMINGS — per-stage latency capture for entry+exit chains.
//   Fire-and-forget rows written by withTiming helper. Bottleneck analysis
//   feeds GET /api/latency and the More tab Latency card.
// =============================================================================

export const signalTimings = pgTable(
  "signal_timings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    signalId: bigint("signal_id", { mode: "number" }).references(() => signals.id, {
      onDelete: "cascade",
    }),
    positionId: bigint("position_id", { mode: "number" }).references(() => positions.id, {
      onDelete: "set null",
    }),
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

// =============================================================================
// NOTIFICATION_SETTINGS — per-user, per-event toggle for Telegram alerts.
//   Default behaviour (no row) is enabled=true. P2d gate.
// =============================================================================

export const notificationSettings = pgTable(
  "notification_settings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .default(1)
      .references(() => users.id, { onDelete: "cascade" }),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_notif_user_event").on(t.userId, t.eventKey)],
);

// =============================================================================
// CALIBRATOR_RECOMMENDATIONS — adaptive filter-threshold tuning output (P2c)
//   Daemon writes one row per (cycle, filter). Read-only for now: emit-only,
//   never auto-apply to strategy_filters. Purely advisory.
// =============================================================================

export const calibratorRecommendations = pgTable(
  "calibrator_recommendations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    cycleId: varchar("cycle_id", { length: 64 }).notNull(),
    filterName: varchar("filter_name", { length: 64 }).notNull(),
    paramKey: varchar("param_key", { length: 64 }).notNull(),
    currentValue: doublePrecision("current_value").notNull(),
    recommendedValue: doublePrecision("recommended_value").notNull(),
    direction: varchar("direction", { length: 16 }).notNull(), // relax | tighten | hold
    liftEstimateUsd: doublePrecision("lift_estimate_usd").notNull(),
    liftKpi: varchar("lift_kpi", { length: 32 }).notNull(),
    confidence: varchar("confidence", { length: 16 }).notNull(), // stable | exploring | low_data
    sampleSize: integer("sample_size").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_calibrator_recs_cycle").on(t.cycleId),
    index("idx_calibrator_recs_created").on(t.createdAt.desc()),
  ],
);
