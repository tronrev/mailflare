-- Sign-up confirmations: the link that proves the address, and when it stops
-- working.
--
-- A confirmation mail is filed by its category like any other, but what makes it
-- useful is the link, so it gets columns of its own rather than sharing the
-- passcode ones: the two are read by different clients (a login form versus a
-- registration flow) and have different lifetimes -- minutes against days.
ALTER TABLE `message_triage` ADD `verify_provider` text;--> statement-breakpoint
ALTER TABLE `message_triage` ADD `verify_url` text;--> statement-breakpoint
ALTER TABLE `message_triage` ADD `verify_code` text;--> statement-breakpoint
ALTER TABLE `message_triage` ADD `verify_expires_at` integer;--> statement-breakpoint

-- The verify endpoint filters on the service it came from: "the code from
-- Trip.com", not "the last code from anyone".
CREATE INDEX IF NOT EXISTS `message_triage_verify_idx` ON `message_triage` (`user_id`,`verify_provider`,`verify_expires_at`);
