-- Bring MySQL to the schema SQLite reached in 0078-0082: sign-up address
-- verification, paid send time, automatic triage and the free send allowance.
--
-- These shipped on D1 only, so a MySQL deployment was missing the tables the
-- runtime already queries. Kept as one migration because no released MySQL
-- database ever saw the intermediate states.
ALTER TABLE `users` ADD `email_verified_at` bigint;--> statement-breakpoint
ALTER TABLE `users` ADD `send_paid_until` bigint;--> statement-breakpoint
ALTER TABLE `users` ADD `send_provider` text;--> statement-breakpoint
ALTER TABLE `users` ADD `send_credentials` text;--> statement-breakpoint
ALTER TABLE `users` ADD `send_credentials_at` bigint;--> statement-breakpoint
ALTER TABLE `users` ADD `auto_triage_enabled` boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE `users` ADD `daily_summary_on` text;--> statement-breakpoint
UPDATE `users` SET `email_verified_at` = `created_at` WHERE `email_verified_at` IS NULL;--> statement-breakpoint
CREATE INDEX `users_email_verified_at_idx` ON `users` (`email_verified_at`);--> statement-breakpoint
CREATE TABLE `email_verification_tokens` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`token_hash` varchar(191) NOT NULL,
	`expires_at` bigint NOT NULL,
	`used_at` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `email_verification_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_verification_tokens_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `email_verification_tokens_user_idx` ON `email_verification_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `usdt_orders` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`months` int NOT NULL,
	`amount_micro` int NOT NULL,
	`address` longtext NOT NULL,
	`status` varchar(64) NOT NULL DEFAULT 'pending',
	`tx_id` varchar(191),
	`created_at` bigint NOT NULL,
	`expires_at` bigint NOT NULL,
	`paid_at` bigint,
	`paid_until` bigint,
	CONSTRAINT `usdt_orders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usdt_orders_tx_idx` ON `usdt_orders` (`tx_id`);--> statement-breakpoint
CREATE INDEX `usdt_orders_user_idx` ON `usdt_orders` (`user_id`);--> statement-breakpoint
CREATE INDEX `usdt_orders_status_idx` ON `usdt_orders` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `message_triage` (
	`message_id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`mailbox_id` varchar(191),
	`category` varchar(64) NOT NULL,
	`confidence` int,
	`source` varchar(64) NOT NULL,
	`model` longtext,
	`otp_provider` longtext,
	`otp_code` longtext,
	`otp_expires_at` bigint,
	`verify_provider` varchar(191),
	`verify_url` longtext,
	`verify_code` longtext,
	`verify_expires_at` bigint,
	`retain_until` bigint,
	`created_at` bigint NOT NULL,
	CONSTRAINT `message_triage_id` PRIMARY KEY(`message_id`)
);
--> statement-breakpoint
CREATE INDEX `message_triage_retain_idx` ON `message_triage` (`retain_until`);--> statement-breakpoint
CREATE INDEX `message_triage_user_idx` ON `message_triage` (`user_id`,`category`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_triage_otp_idx` ON `message_triage` (`user_id`,`otp_code`);--> statement-breakpoint
CREATE INDEX `message_triage_verify_idx` ON `message_triage` (`user_id`,`verify_provider`,`verify_expires_at`);--> statement-breakpoint
CREATE TABLE `send_allowance_uses` (
	`id` varchar(191) NOT NULL,
	`user_id` varchar(191) NOT NULL,
	`provider` longtext,
	`created_at` bigint NOT NULL,
	CONSTRAINT `send_allowance_uses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `send_allowance_uses_user_time_idx` ON `send_allowance_uses` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `email_verification_tokens` ADD CONSTRAINT `email_verification_tokens_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `usdt_orders` ADD CONSTRAINT `usdt_orders_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_triage` ADD CONSTRAINT `message_triage_message_id_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_triage` ADD CONSTRAINT `message_triage_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `message_triage` ADD CONSTRAINT `message_triage_mailbox_id_mailboxes_id_fk` FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `send_allowance_uses` ADD CONSTRAINT `send_allowance_uses_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
