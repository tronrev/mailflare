import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { purgeAccount } from "./deletion";

export type RecoveryGapAccount = {
	id: string;
	email: string;
	role: string;
	isPrimaryAdmin: boolean;
	createdAt: Date;
};

/**
 * Accounts that cannot recover themselves: no recovery address, so a forgotten
 * password is the end of the account and nothing can reach the person behind it.
 *
 * Administrators are never in this list. Deleting the account that can still log
 * in and fix the others is not cleanup, it is a lockout — the rule is "an account
 * nobody can recover from", not "a row with an empty column".
 */
export async function listAccountsWithoutRecovery(env: CloudflareEnv): Promise<RecoveryGapAccount[]> {
	const db = getDb(env);
	return db
		.select({
			id: users.id,
			email: users.email,
			role: users.role,
			isPrimaryAdmin: users.isPrimaryAdmin,
			createdAt: users.createdAt,
		})
		.from(users)
		.where(and(
			// Rows written before the schema normalized this can hold "" instead of null.
			or(isNull(users.resetEmail), eq(users.resetEmail, "")),
			isNull(users.deletedAt),
			eq(users.isPrimaryAdmin, false),
			eq(users.role, "user"),
		));
}

/**
 * Cleans up accounts that predate the rule that every account needs a recovery
 * address.
 *
 * It only acts when the deployment says so (`RECOVERY_EMAIL_ENFORCE=purge`), and
 * otherwise just reports what it found. This is a one-off migration of existing
 * data, not a standing policy: an account that loses its recovery address later
 * should be told to fill it in, not silently deleted by a cron.
 */
export async function runRecoveryEmailEnforcement(env: CloudflareEnv): Promise<{ candidates: number; purged: number }> {
	const db = getDb(env);
	const candidates = await listAccountsWithoutRecovery(env);
	if (env.RECOVERY_EMAIL_ENFORCE !== "purge") {
		if (candidates.length) {
			console.info(
				`[recovery] ${candidates.length} account(s) have no recovery address; set RECOVERY_EMAIL_ENFORCE=purge to remove them: ${candidates.map((row) => row.email).join(", ")}`,
			);
		}
		return { candidates: candidates.length, purged: 0 };
	}

	let purged = 0;
	for (const candidate of candidates) {
		const [account] = await db.select().from(users).where(eq(users.id, candidate.id)).limit(1);
		if (!account) continue;
		try {
			await purgeAccount(env, account);
			purged += 1;
		} catch (error) {
			console.error(`[recovery] could not remove ${candidate.email}:`, error instanceof Error ? error.message : String(error));
		}
	}
	if (purged) console.info(`[recovery] removed ${purged} account(s) without a recovery address`);
	return { candidates: candidates.length, purged };
}
