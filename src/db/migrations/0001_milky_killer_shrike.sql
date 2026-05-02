CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" bigint NOT NULL,
	"actor" varchar(32) NOT NULL,
	"user_id" bigint,
	"action" varchar(64) NOT NULL,
	"target" varchar(128),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_config" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" varchar(16) DEFAULT 'global' NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" jsonb NOT NULL,
	"set_by_user_id" bigint,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_config" ADD CONSTRAINT "runtime_config_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_log_ts" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_runtime_config_scope_key" ON "runtime_config" USING btree ("scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_config_scope_key" ON "runtime_config" USING btree ("scope","key");