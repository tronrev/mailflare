-- The free allowance: a few messages a day through the deployment's own
-- provider, before an account has to bring a key or buy time.
--
-- One row per send rather than a counter column on `users`, because the window
-- slides: a 24-hour count has to know *when* each message went, and a counter
-- would either reset at midnight (handing out six messages around it) or need a
-- second column holding the window's start. Rows also expire on their own —
-- anything older than a day is unread garbage that can be swept.
CREATE TABLE `send_allowance_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`provider` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `send_allowance_uses_user_time_idx` ON `send_allowance_uses` (`user_id`,`created_at`);
