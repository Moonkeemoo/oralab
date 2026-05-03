CREATE TABLE IF NOT EXISTS "calibrator_beliefs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reject_key" varchar(64) NOT NULL,
	"sport" varchar(32),
	"alpha" double precision DEFAULT 1 NOT NULL,
	"beta" double precision DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calibrator_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value_num" double precision,
	"value_text" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calibrator_trace" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" varchar(64) NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cf_attribution" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reject_key" varchar(64) NOT NULL,
	"sport" varchar(32),
	"window_start_ts" bigint NOT NULL,
	"window_end_ts" bigint NOT NULL,
	"reject_count" integer DEFAULT 0 NOT NULL,
	"data_points" integer DEFAULT 0 NOT NULL,
	"winners_blocked" integer DEFAULT 0 NOT NULL,
	"losers_blocked" integer DEFAULT 0 NOT NULL,
	"avg_winner_pnl" double precision DEFAULT 0 NOT NULL,
	"avg_loser_pnl" double precision DEFAULT 0 NOT NULL,
	"saved_usd" double precision DEFAULT 0 NOT NULL,
	"lost_usd" double precision DEFAULT 0 NOT NULL,
	"net_usd" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cf_pending" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"condition_id" varchar(128) NOT NULL,
	"reject_key" varchar(64) NOT NULL,
	"asset_id" varchar(128) NOT NULL,
	"sport" varchar(32),
	"whale_price" double precision,
	"hypothetical_size_usd" double precision,
	"recorded_ts" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calibrator_recommendations" ADD COLUMN IF NOT EXISTS "lift_matrix" jsonb;--> statement-breakpoint
ALTER TABLE "calibrator_recommendations" ADD COLUMN IF NOT EXISTS "aims" jsonb;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "league" varchar(32);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "sport" varchar(32);--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN IF NOT EXISTS "sport" varchar(32);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cal_beliefs_key_sport" ON "calibrator_beliefs" USING btree ("reject_key","sport");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cal_trace_cycle" ON "calibrator_trace" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cal_trace_ts" ON "calibrator_trace" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cf_attribution_key_sport_window" ON "cf_attribution" USING btree ("reject_key","sport","window_start_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cf_attribution_window" ON "cf_attribution" USING btree ("window_end_ts" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_cf_pending_cid_key" ON "cf_pending" USING btree ("condition_id","reject_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cf_pending_recorded" ON "cf_pending" USING btree ("recorded_ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_positions_sport_lastchange" ON "positions" USING btree ("sport","last_state_change_ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_signals_sport_processed" ON "signals" USING btree ("sport","processed_at" DESC NULLS LAST) WHERE accepted = false;