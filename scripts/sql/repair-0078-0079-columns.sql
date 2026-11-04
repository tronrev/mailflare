-- Repair: migrations 0078 and 0079 never reached this database.
--
-- Observed 2026-11-04 on database f33739c2 ("mailflare"):
--   `users` has 27 columns and stops at `deleted_at`; `email_verified_at`,
--   `send_paid_until`, `send_provider`, `send_credentials`,
--   `send_credentials_at` are all absent, and `email_verification_tokens`
--   does not exist -- yet `usdt_orders` does, because it was created by hand
--   (repair-0079-usdt-orders.sql) without the rest of migration 0079.
--
-- Consequence: every read that selects `users` in full fails with
-- `no such column: ...`. That is what the 5-minute cron logged at 00:00
-- ("Failed query: select <users columns> ...") and what /api/billing answered
-- with a bare 500 "Could not load sending settings".
--
-- Why not `wrangler d1 migrations apply`: 0079 opens with
-- `CREATE TABLE usdt_orders`, which already exists here and holds rows, so an
-- apply would abort part way through. Everything below is additive.
--
-- The UPDATE is not optional. `runUnverifiedSignupPurge` deletes accounts
-- older than 24 hours whose `email_verified_at` is null, so adding the column
-- without the backfill would let the next cron tick eat every existing
-- account. Both statements must land in the same run.

ALTER TABLE `users` ADD `email_verified_at` integer;
UPDATE `users` SET `email_verified_at` = `created_at` WHERE `email_verified_at` IS NULL;

CREATE TABLE IF NOT EXISTS `email_verification_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`token_hash` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `email_verification_tokens_user_idx` ON `email_verification_tokens` (`user_id`);
CREATE INDEX IF NOT EXISTS `users_email_verified_at_idx` ON `users` (`email_verified_at`);

ALTER TABLE `users` ADD `send_paid_until` integer;
ALTER TABLE `users` ADD `send_provider` text;
ALTER TABLE `users` ADD `send_credentials` text;
ALTER TABLE `users` ADD `send_credentials_at` integer;

-- 0079's table survived the manual repair, its indexes may not have.
CREATE UNIQUE INDEX IF NOT EXISTS `usdt_orders_tx_idx` ON `usdt_orders` (`tx_id`);
CREATE INDEX IF NOT EXISTS `usdt_orders_user_idx` ON `usdt_orders` (`user_id`);
CREATE INDEX IF NOT EXISTS `usdt_orders_status_idx` ON `usdt_orders` (`status`,`expires_at`);

-- Record both migrations, so the next `migrations apply` starts at 0080
-- instead of re-running 0078/0079 against columns that now exist.
INSERT OR IGNORE INTO `d1_migrations` (`name`) VALUES ('0078_add_email_verification');
INSERT OR IGNORE INTO `d1_migrations` (`name`) VALUES ('0079_add_send_entitlements_and_usdt_orders');
