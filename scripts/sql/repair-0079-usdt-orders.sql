-- Finishes migration 0079 on a database where it stopped half way: the four
-- `users` columns went in, the orders table did not. That leaves every billing
-- endpoint answering 500 ("no such table: usdt_orders") while the app otherwise
-- works, and `wrangler d1 migrations apply` cannot repair it on its own because
-- re-running the original file would fail on the columns that already exist.
--
--   npx wrangler d1 execute DB --remote --file=scripts/sql/repair-0079-usdt-orders.sql
--
-- Every statement is idempotent: on a healthy database this does nothing. It
-- does not add the `users` columns — those are what is already there. If
-- `PRAGMA table_info(users)` does not show `send_paid_until`, this is the wrong
-- repair and the full migration has to be applied instead.

CREATE TABLE IF NOT EXISTS `d1_migrations` (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS `usdt_orders` (
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

CREATE UNIQUE INDEX IF NOT EXISTS `usdt_orders_tx_idx` ON `usdt_orders` (`tx_id`);
CREATE INDEX IF NOT EXISTS `usdt_orders_user_idx` ON `usdt_orders` (`user_id`);
CREATE INDEX IF NOT EXISTS `usdt_orders_status_idx` ON `usdt_orders` (`status`, `expires_at`);

INSERT OR IGNORE INTO `d1_migrations` (`name`) VALUES ('0079_add_send_entitlements_and_usdt_orders');
