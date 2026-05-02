ALTER TABLE "positions" ADD COLUMN "mode" varchar(8) DEFAULT 'DRY' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_positions_mode_status" ON "positions" USING btree ("mode","status");