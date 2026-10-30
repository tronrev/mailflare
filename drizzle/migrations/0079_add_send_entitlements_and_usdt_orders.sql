ALTER TABLE `users` ADD `send_paid_until` integer;
--> statement-breakpoint
ALTER TABLE `users` ADD `send_provider` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `send_credentials` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `send_credentials_at` integer;
--> statement-breakpoint
CREATE TABLE `usdt_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`months` integer NOT NULL,
	`amount_micro` integer NOT NULL,
	`address` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tx_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`paid_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usdt_orders_tx_idx` ON `usdt_orders` (`tx_id`);
--> statement-breakpoint
CREATE INDEX `usdt_orders_user_idx` ON `usdt_orders` (`user_id`);
--> statement-breakpoint
CREATE INDEX `usdt_orders_status_idx` ON `usdt_orders` (`status`,`expires_at`);
