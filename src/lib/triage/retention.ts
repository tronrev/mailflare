import { and, inArray, isNotNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { messageTriage, messages } from "@/db/schema";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";

/** One cron tick deletes at most this many; a backlog drains over a few ticks. */
export const TRIAGE_RETENTION_BATCH = 200;

/**
 * Deletes messages whose category says they have outlived their use: a passcode
 * the moment it stops working, promotions after a month, notifications after a
 * quarter, and never for anything a person wrote.
 *
 * The decision was made and stored at classification time (`retain_until`), so
 * this is a plain scan — no model, no per-mailbox rules, no surprises.
 */
export async function runTriageRetention(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const expired = await db
		.select({ messageId: messageTriage.messageId })
		.from(messageTriage)
		.where(and(isNotNull(messageTriage.retainUntil), lt(messageTriage.retainUntil, now)))
		.limit(TRIAGE_RETENTION_BATCH);
	if (expired.length === 0) return 0;

	const ids = expired.map((row) => row.messageId);
	const rows = await db
		.select({
			id: messages.id,
			userId: messages.userId,
			mailboxId: messages.mailboxId,
			rawR2Key: messages.rawR2Key,
			status: messages.status,
		})
		.from(messages)
		.where(inArray(messages.id, ids));

	let deleted = 0;
	const byOwner = new Map<string, typeof rows>();
	for (const row of rows) {
		const bucket = byOwner.get(row.userId);
		if (bucket) bucket.push(row);
		else byOwner.set(row.userId, [row]);
	}
	for (const [userId, owned] of byOwner) {
		try {
			deleted += await permanentlyDeleteMessages(env, db, userId, owned, "retention");
		} catch (error) {
			console.error("[triage] retention delete failed:", error instanceof Error ? error.message : String(error));
		}
	}

	// Rows for messages that were already deleted elsewhere are swept too, so the
	// table cannot accumulate tombstones.
	const gone = ids.filter((id) => !rows.some((row) => row.id === id));
	const cleanup = [...gone, ...rows.map((row) => row.id)];
	if (cleanup.length) await db.delete(messageTriage).where(inArray(messageTriage.messageId, cleanup));
	return deleted;
}
