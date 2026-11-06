-- Automatic triage: what each inbound message is, when it can go, and what a
-- one-time passcode in it said.
--
-- `message_triage` is separate from `messages` because only inbound mail has a
-- verdict, and because the retention sweep scans by `retain_until` on every
-- five-minute tick -- it should not walk the message table to find candidates.
CREATE TABLE `message_triage` (
	`message_id` text PRIMARY KEY NOT NULL REFERENCES `messages`(`id`) ON DELETE cascade,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE set null,
	`category` text NOT NULL,
	`confidence` integer,
	`source` text NOT NULL,
	`model` text,
	`otp_provider` text,
	`otp_code` text,
	`otp_expires_at` integer,
	`retain_until` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_triage_retain_idx` ON `message_triage` (`retain_until`);--> statement-breakpoint
CREATE INDEX `message_triage_user_idx` ON `message_triage` (`user_id`,`category`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_triage_otp_idx` ON `message_triage` (`user_id`,`otp_code`);--> statement-breakpoint

-- Every account gets triage unless it turns it off. Existing accounts are opted
-- in as well: the columns default to on, and a deployment that objects can flip
-- them with one UPDATE.
ALTER TABLE `users` ADD `auto_triage_enabled` integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- Local date of the last daily summary, so the three cron ticks inside the
-- user's midnight hour post one summary instead of three.
ALTER TABLE `users` ADD `daily_summary_on` text;
