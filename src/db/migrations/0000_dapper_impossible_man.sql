CREATE TABLE "decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"position_id" bigint,
	"signal_id" bigint,
	"input_snapshot" jsonb NOT NULL,
	"output_intent" jsonb NOT NULL,
	"gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"duration_ms" integer,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"position_id" bigint,
	"order_id" bigint,
	"tx_hash" varchar(66) NOT NULL,
	"side" varchar(4) NOT NULL,
	"shares" double precision NOT NULL,
	"price" double precision NOT NULL,
	"fee_usd" double precision DEFAULT 0 NOT NULL,
	"ts" bigint NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" varchar(16) NOT NULL,
	"scope_id" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"reason" text,
	"set_by_user_id" bigint,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lifecycle_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"position_id" bigint,
	"event" varchar(64) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"condition_id" varchar(66) PRIMARY KEY NOT NULL,
	"slug" varchar(256),
	"question" text,
	"neg_risk" boolean NOT NULL,
	"tick_size" double precision NOT NULL,
	"min_order_size" double precision NOT NULL,
	"maker_fee_bps" integer DEFAULT 0 NOT NULL,
	"taker_fee_bps" integer DEFAULT 0 NOT NULL,
	"end_date_ts" bigint,
	"sport_league" varchar(32),
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" varchar(96) NOT NULL,
	"src" varchar(24) NOT NULL,
	"mark" double precision NOT NULL,
	"bid" double precision,
	"ask" double precision,
	"peak" double precision,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"position_id" bigint,
	"mode" varchar(8) NOT NULL,
	"side" varchar(4) NOT NULL,
	"price" double precision NOT NULL,
	"size" double precision NOT NULL,
	"expiration_ts" bigint,
	"client_order_id" varchar(66) NOT NULL,
	"clob_order_id" varchar(66),
	"status" varchar(24) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"raw_request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"wallet_id" bigint NOT NULL,
	"strategy_id" bigint NOT NULL,
	"signal_id" bigint,
	"condition_id" varchar(66) NOT NULL,
	"asset_id" varchar(96) NOT NULL,
	"side" varchar(4) NOT NULL,
	"status" varchar(16) NOT NULL,
	"shares" double precision DEFAULT 0 NOT NULL,
	"fill_price" double precision DEFAULT 0 NOT NULL,
	"peak_price" double precision DEFAULT 0 NOT NULL,
	"fill_ts" bigint,
	"last_state_change_ts" bigint NOT NULL,
	"trail_armed" boolean DEFAULT false NOT NULL,
	"sweep_count" integer DEFAULT 0 NOT NULL,
	"entry_cost_usd" double precision DEFAULT 0 NOT NULL,
	"realized_pnl_usd" double precision,
	"close_reason" varchar(64),
	"close_tx_hash" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"strategy_id" bigint NOT NULL,
	"source" varchar(32) NOT NULL,
	"condition_id" varchar(66) NOT NULL,
	"asset_id" varchar(96) NOT NULL,
	"side" varchar(4) NOT NULL,
	"price_hint" double precision,
	"volume_usd_hint" double precision,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted" boolean,
	"reject_reason" varchar(64),
	"received_ts" bigint NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sports_events" (
	"game_id" varchar(64) PRIMARY KEY NOT NULL,
	"league" varchar(32) NOT NULL,
	"home_team" varchar(128),
	"away_team" varchar(128),
	"score" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"period" varchar(32),
	"status" varchar(32) NOT NULL,
	"started_at" timestamp with time zone,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"name" varchar(64) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strategy_filters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_id" bigint NOT NULL,
	"filter_name" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"telegram_chat_id" bigint,
	"telegram_username" varchar(64),
	"role" varchar(16) DEFAULT 'user' NOT NULL,
	"locale" varchar(8) DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"address" varchar(42) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"signature_type" integer DEFAULT 1 NOT NULL,
	"encrypted_private_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whales" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"strategy_id" bigint NOT NULL,
	"address" varchar(42) NOT NULL,
	"label" varchar(64),
	"classification" varchar(32) DEFAULT 'UNCLASSIFIED' NOT NULL,
	"confidence" double precision DEFAULT 0 NOT NULL,
	"tracked" boolean DEFAULT false NOT NULL,
	"sports_domains" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chain_metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_classified_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kill_switches" ADD CONSTRAINT "kill_switches_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_filters" ADD CONSTRAINT "strategy_filters_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whales" ADD CONSTRAINT "whales_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_decisions_position_ts" ON "decisions" USING btree ("position_id","ts");--> statement-breakpoint
CREATE INDEX "idx_decisions_user_ts" ON "decisions" USING btree ("user_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fills_tx_hash_position" ON "fills" USING btree ("tx_hash","position_id");--> statement-breakpoint
CREATE INDEX "idx_fills_position_ts" ON "fills" USING btree ("position_id","ts");--> statement-breakpoint
CREATE INDEX "idx_kill_switches_active" ON "kill_switches" USING btree ("active");--> statement-breakpoint
CREATE INDEX "idx_kill_switches_scope" ON "kill_switches" USING btree ("scope","scope_id");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_user_ts" ON "lifecycle_events" USING btree ("user_id","ts");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_position_ts" ON "lifecycle_events" USING btree ("position_id","ts");--> statement-breakpoint
CREATE INDEX "idx_lifecycle_event" ON "lifecycle_events" USING btree ("event");--> statement-breakpoint
CREATE INDEX "idx_markets_end_date" ON "markets" USING btree ("end_date_ts");--> statement-breakpoint
CREATE INDEX "idx_marks_asset_ts" ON "marks" USING btree ("asset_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_orders_client_id" ON "orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "idx_orders_position" ON "orders" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_positions_user_status" ON "positions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_positions_condition_asset" ON "positions" USING btree ("condition_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_positions_open_per_asset" ON "positions" USING btree ("user_id","asset_id") WHERE status IN ('PENDING','FILLED','OPEN','EXITING','RESOLVED','FROZEN');--> statement-breakpoint
CREATE INDEX "idx_signals_user_received" ON "signals" USING btree ("user_id","received_ts");--> statement-breakpoint
CREATE INDEX "idx_signals_strategy_received" ON "signals" USING btree ("strategy_id","received_ts");--> statement-breakpoint
CREATE INDEX "idx_signals_condition" ON "signals" USING btree ("condition_id");--> statement-breakpoint
CREATE INDEX "idx_sports_events_league" ON "sports_events" USING btree ("league");--> statement-breakpoint
CREATE INDEX "idx_sports_events_status" ON "sports_events" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_strategies_user_name" ON "strategies" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_strategy_filters_strat_name" ON "strategy_filters" USING btree ("strategy_id","filter_name");--> statement-breakpoint
CREATE INDEX "idx_users_telegram_chat_id" ON "users" USING btree ("telegram_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wallets_user_address" ON "wallets" USING btree ("user_id","address");--> statement-breakpoint
CREATE INDEX "idx_wallets_user" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_whales_strategy_address" ON "whales" USING btree ("strategy_id","address");--> statement-breakpoint
CREATE INDEX "idx_whales_tracked" ON "whales" USING btree ("tracked");