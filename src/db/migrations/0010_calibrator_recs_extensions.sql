-- Phase B+C extensions to calibrator_recommendations:
--   sport (per-sport recs vs global)
--   applied_at (engine apply path stamps when watch→auto applies)
--   rolled_back_at (rollback verification path stamps when WR drops)
ALTER TABLE "calibrator_recommendations" ADD COLUMN IF NOT EXISTS "sport" varchar(32);--> statement-breakpoint
ALTER TABLE "calibrator_recommendations" ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calibrator_recommendations" ADD COLUMN IF NOT EXISTS "rolled_back_at" timestamp with time zone;
