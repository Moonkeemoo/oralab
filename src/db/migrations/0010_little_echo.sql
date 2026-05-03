ALTER TABLE "calibrator_recommendations" ADD COLUMN "sport" varchar(32);--> statement-breakpoint
ALTER TABLE "calibrator_recommendations" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calibrator_recommendations" ADD COLUMN "rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "whale_address" varchar(64);--> statement-breakpoint
CREATE INDEX "idx_positions_whale" ON "positions" USING btree ("whale_address");