CREATE TABLE "signal_timings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signal_id" bigint,
	"position_id" bigint,
	"chain" varchar(8) NOT NULL,
	"stage" varchar(40) NOT NULL,
	"duration_ms" integer NOT NULL,
	"ts" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_timings" ADD CONSTRAINT "signal_timings_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_timings" ADD CONSTRAINT "signal_timings_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_signal_timings_signal" ON "signal_timings" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "idx_signal_timings_chain_stage" ON "signal_timings" USING btree ("chain","stage");