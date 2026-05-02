CREATE TABLE "notification_settings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint DEFAULT 1 NOT NULL,
	"event_key" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notif_user_event" ON "notification_settings" USING btree ("user_id","event_key");