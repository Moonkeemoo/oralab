ALTER TABLE "whales" ADD COLUMN "sm_score" double precision;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "trust_score" double precision;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "total_trades" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "win_rate" double precision;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "avg_hold_hours" double precision;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "directional_ratio" double precision;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "domain_breakdown" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "whales" ADD COLUMN "per_domain_classification" jsonb DEFAULT '{}'::jsonb;