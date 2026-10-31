import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { emailVerificationTokens, users } from "@/db/schema";
import { newId } from "@/lib/ids";
import { hashSessionToken } from "@/lib/auth/session";
import { getBranding } from "@/lib/branding/service";
import { sendSystemEmail } from "@/lib/email/system-mail";
import type { Translator } from "@/lib/i18n/utils";
import { buildVerificationEmail } from "@/lib/auth/verify-email-mail";

/**
 * How long a self-service account may sit unconfirmed. The address was typed by
 * a stranger and never proved; 24 hours is enough for anyone to open a mailbox
 * and long enough that a slow inbox or a vacation autoresponder does not lose
 * the account. After this, the scheduled purge erases it and its address is
 * free again.
 */
export const VERIFICATION_HOURS = 24;
export { buildVerificationEmail };

/**
 * Mails a fresh confirmation link and returns whether it got out. Any earlier
 * unused link is burned first, so only the newest message in an inbox works —
 * people click the top one.
 */
export async function issueEmailVerification(
	env: CloudflareEnv,
	input: { userId: string; email: string; recoveryEmail: string; origin: string; t: Translator },
): Promise<boolean> {
	const db = getDb(env);
	const now = new Date();
	await db
		.update(emailVerificationTokens)
		.set({ usedAt: now })
		.where(and(eq(emailVerificationTokens.userId, input.userId), isNull(emailVerificationTokens.usedAt)));

	const token = newId("evt");
	await db.insert(emailVerificationTokens).values({
		id: newId(),
		userId: input.userId,
		tokenHash: await hashSessionToken(token),
		expiresAt: new Date(now.getTime() + VERIFICATION_HOURS * 60 * 60 * 1000),
	});

	const link = `${input.origin}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
	const { appName } = await getBranding(env);
	try {
		const sent = await sendSystemEmail(env, {
			to: input.recoveryEmail,
			...buildVerificationEmail(input.t, {
				email: input.email,
				appName,
				link,
				hours: VERIFICATION_HOURS,
			}),
		});
		if (!sent) console.warn("Confirmation link could not be delivered: no domain on this server can send mail");
		return sent;
	} catch (error) {
		console.warn("Confirmation link could not be delivered", error);
		return false;
	}
}

/**
 * Redeems a link. Returns the user id so the caller can sign them in: opening a
 * link that was mailed to their own recovery address is exactly as strong a
 * proof of identity as the password they just chose.
 */
export async function consumeEmailVerification(
	env: CloudflareEnv,
	token: string,
): Promise<{ ok: true; userId: string } | { ok: false }> {
	if (!token) return { ok: false };
	const db = getDb(env);
	const [row] = await db
		.select({ id: emailVerificationTokens.id, userId: emailVerificationTokens.userId })
		.from(emailVerificationTokens)
		.where(
			and(
				eq(emailVerificationTokens.tokenHash, await hashSessionToken(token)),
				gt(emailVerificationTokens.expiresAt, new Date()),
				isNull(emailVerificationTokens.usedAt),
			),
		)
		.limit(1);
	if (!row) return { ok: false };

	const [account] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
	if (!account || account.disabled || account.deletedAt) return { ok: false };

	const now = new Date();
	await db.update(emailVerificationTokens).set({ usedAt: now }).where(eq(emailVerificationTokens.id, row.id));
	if (!account.emailVerifiedAt) {
		await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, row.userId));
	}
	return { ok: true, userId: row.userId };
}

/**
 * Mails a fresh link for an address that has not confirmed yet. Silent about
 * everything else: an unknown address, a confirmed one and a disabled account
 * all look the same from outside, so the form cannot be used to probe.
 */
export async function resendEmailVerification(
	env: CloudflareEnv,
	email: string,
	origin: string,
	t: Translator,
): Promise<void> {
	const address = email.trim().toLowerCase();
	if (!address) return;
	const db = getDb(env);
	const [account] = await db.select().from(users).where(eq(users.email, address)).limit(1);
	if (!account || account.disabled || account.deletedAt || account.emailVerifiedAt) return;
	if (!account.resetEmail) return;
	await issueEmailVerification(env, {
		userId: account.id,
		email: account.email,
		recoveryEmail: account.resetEmail,
		origin,
		t,
	});
}

/**
 * Unconfirmed accounts older than the window. Selected in the deletion module so
 * data erasure lives in one place; this predicate is the only thing it needs.
 */
export function unverifiedCutoff(now = new Date()): Date {
	return new Date(now.getTime() - VERIFICATION_HOURS * 60 * 60 * 1000);
}

export function unconfirmedAccountFilter(now = new Date()) {
	return and(isNull(users.emailVerifiedAt), lte(users.createdAt, unverifiedCutoff(now)));
}
