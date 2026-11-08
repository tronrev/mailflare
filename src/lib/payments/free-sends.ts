import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { sendAllowanceUses } from "@/db/schema";
import { newId } from "@/lib/ids";
import { FREE_SEND_WINDOW_MS, freeSendState, type FreeSendState } from "@/lib/payments/free-send-rules";

/**
 * Reading and spending the free allowance.
 *
 * Reading and spending are separate on purpose: the settings page and the
 * composer ask "how many are left?" all day long, and only an actual send may
 * write a row. `claim` writes the row *before* the message goes out and
 * `release` takes it back when the provider refuses, so a send that failed does
 * not eat one of the three.
 *
 * Two sends racing each other can both read "one left" and both go out — a
 * fourth message in a day, not a security hole, and closing it would mean a
 * transaction across a network call to the mail provider. The cap is about
 * keeping the deployment's own sending bill bounded, and it stays bounded.
 */

/** Rows matching this account inside the window, reduced to the allowance state. */
export async function readFreeSendState(env: CloudflareEnv, userId: string, now = Date.now()): Promise<FreeSendState> {
	const since = new Date(now - FREE_SEND_WINDOW_MS);
	const rows = await getDb(env)
		.select({ createdAt: sendAllowanceUses.createdAt })
		.from(sendAllowanceUses)
		.where(and(eq(sendAllowanceUses.userId, userId), gt(sendAllowanceUses.createdAt, since)));
	return freeSendState(
		rows.map((row) => row.createdAt.getTime()),
		now,
	);
}

export type FreeSendClaim = { id: string; state: FreeSendState };

/**
 * Spend one slot, or `null` when there is none left.
 *
 * The state returned counts this claim, so the caller can tell the account how
 * many messages are left *after* this one.
 */
export async function claimFreeSend(
	env: CloudflareEnv,
	options: { userId: string; provider?: string | null; now?: number },
): Promise<FreeSendClaim | null> {
	const now = options.now ?? Date.now();
	const before = await readFreeSendState(env, options.userId, now);
	if (before.exhausted) return null;
	const id = newId("sal");
	await getDb(env)
		.insert(sendAllowanceUses)
		.values({ id, userId: options.userId, provider: options.provider ?? null, createdAt: new Date(now) });
	return {
		id,
		state: { ...before, used: before.used + 1, remaining: Math.max(0, before.remaining - 1), exhausted: before.remaining - 1 <= 0 },
	};
}

/** Give a slot back: the message never left. */
export async function releaseFreeSend(env: CloudflareEnv, id: string): Promise<void> {
	try {
		await getDb(env).delete(sendAllowanceUses).where(eq(sendAllowanceUses.id, id));
	} catch (error) {
		// A slot that cannot be returned is a wasted free message, not a failed one;
		// the send itself already succeeded or already failed for its own reason.
		console.error("[allowance] could not release a slot:", error);
	}
}
