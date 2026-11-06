-- Who would the recovery-address cleanup remove?
--
-- Read this first. The scheduled task skips administrators and the primary
-- admin on purpose: deleting the account that can still log in is a lockout,
-- not cleanup. `wrangler d1 execute mailflare --remote --file=./scripts/sql/list-accounts-without-recovery.sql`
SELECT id, email, role, is_primary_admin, datetime(created_at, 'unixepoch') AS created
FROM users
WHERE (reset_email IS NULL OR reset_email = '')
  AND deleted_at IS NULL
  AND is_primary_admin = 0
  AND role = 'user'
ORDER BY created_at ASC;

-- And who is protected by that rule (empty recovery address, but an administrator):
SELECT id, email, role, is_primary_admin, datetime(created_at, 'unixepoch') AS created
FROM users
WHERE (reset_email IS NULL OR reset_email = '')
  AND deleted_at IS NULL
  AND (is_primary_admin = 1 OR role = 'admin')
ORDER BY created_at ASC;
