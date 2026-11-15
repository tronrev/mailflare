-- Bring PostgreSQL to the schema SQLite reached in 0078-0082: sign-up address
-- verification, paid send time, automatic triage and the free send allowance.
--
-- These shipped on D1 only, so a PostgreSQL deployment was missing the tables
-- the runtime already queries. Kept as one migration because no released
-- PostgreSQL database ever saw the intermediate states.
ALTER TABLE "users" ADD COLUMN "email_verified_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "send_paid_until" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "send_provider" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "send_credentials" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "send_credentials_at" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auto_triage_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_summary_on" text;--> statement-breakpoint
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;--> statement-breakpoint
CREATE INDEX "users_email_verified_at_idx" ON "users" USING btree ("email_verified_at");--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "email_verification_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "email_verification_tokens_user_idx" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "usdt_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"months" integer NOT NULL,
	"amount_micro" integer NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"tx_id" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"paid_at" bigint,
	"paid_until" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "usdt_orders_tx_idx" ON "usdt_orders" USING btree ("tx_id");--> statement-breakpoint
CREATE INDEX "usdt_orders_user_idx" ON "usdt_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usdt_orders_status_idx" ON "usdt_orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE TABLE "message_triage" (
	"message_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mailbox_id" text,
	"category" text NOT NULL,
	"confidence" integer,
	"source" text NOT NULL,
	"model" text,
	"otp_provider" text,
	"otp_code" text,
	"otp_expires_at" bigint,
	"verify_provider" text,
	"verify_url" text,
	"verify_code" text,
	"verify_expires_at" bigint,
	"retain_until" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "message_triage_retain_idx" ON "message_triage" USING btree ("retain_until");--> statement-breakpoint
CREATE INDEX "message_triage_user_idx" ON "message_triage" USING btree ("user_id","category","created_at");--> statement-breakpoint
CREATE INDEX "message_triage_otp_idx" ON "message_triage" USING btree ("user_id","otp_code");--> statement-breakpoint
CREATE INDEX "message_triage_verify_idx" ON "message_triage" USING btree ("user_id","verify_provider","verify_expires_at");--> statement-breakpoint
CREATE TABLE "send_allowance_uses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "send_allowance_uses_user_time_idx" ON "send_allowance_uses" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usdt_orders" ADD CONSTRAINT "usdt_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_triage" ADD CONSTRAINT "message_triage_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_triage" ADD CONSTRAINT "message_triage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_triage" ADD CONSTRAINT "message_triage_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_allowance_uses" ADD CONSTRAINT "send_allowance_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
