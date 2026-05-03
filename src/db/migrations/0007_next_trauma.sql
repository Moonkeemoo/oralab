CREATE TABLE "calibrator_recommendations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"cycle_id" varchar(64) NOT NULL,
	"filter_name" varchar(64) NOT NULL,
	"param_key" varchar(64) NOT NULL,
	"current_value" double precision NOT NULL,
	"recommended_value" double precision NOT NULL,
	"direction" varchar(16) NOT NULL,
	"lift_estimate_usd" double precision NOT NULL,
	"lift_kpi" varchar(32) NOT NULL,
	"confidence" varchar(16) NOT NULL,
	"sample_size" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_calibrator_recs_cycle" ON "calibrator_recommendations" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "idx_calibrator_recs_created" ON "calibrator_recommendations" USING btree ("created_at" DESC NULLS LAST);