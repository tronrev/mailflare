import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { ensureBookingUsername } from "@/lib/booking/username";
import { rollbackEmailRoutingRuleChanges } from "@/lib/cloudflare-api";
import type { CfEmailRoutingRuleChange } from "@/lib/cloudflare-api.types";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import {
	checkRecoveryEmail,
	checkSignupPassword,
	checkSignupUsername,
	signupAddress,
} from "./signup-rules";

export type SignupDomain = {
	id: string;
	hostname: string;
	zoneId: string;
	receivingProvider: "none" | "cloudflare" | "resend" | "ses";
};

/**
 * The domain a stranger may register an address on.
 *
 * A self-hosted deployment has one obvious answer: an active domain it already
 * receives mail for. Domains owned by individual accounts are all candidates
 * here on purpose — the operator configured this server, and the sign-up page
 * shows the resulting address before anyone commits to it.
 *
 * A domain whose mail lands through Cloudflare is preferred because that is the
 * only case where an address has to be opened explicitly (a routing rule per
 * address); catch-all providers accept new addresses on their own.
 */
export async function getSignupDomain(env: CloudflareEnv): Promise<SignupDomain | null> {
	const db = getDb(env);
	const rows = await db
		.select({
			id: domains.id,
			hostname: domains.hostname,
			zoneId: domains.zoneId,
			receivingProvider: domains.receivingProvider,
		})
		.from(domains)
		.where(eq(domains.status, "active"));
	if (rows.length === 0) return null;
	return rows.find((row) => row.receivingProvider === "cloudflare") ?? rows[0];
}

export type SignupInput = {
	username: unknown;
	password: unknown;
	recoveryEmail?: unknown;
};

export type SignupOutcome =
	| { ok: true; userId: string; mailboxId: string; email: string }
	| { ok: false; status: number; error: string };

/**
 * Creates a stand-alone personal account: a login, one mailbox, and the routing
 * that lets mail reach it. It deliberately does not touch domains, aliases or
 * sharing — a new account starts with exactly the address it signed up for.
 *
 * Callers must have already passed Turnstile and the rate limit; this function
 * is about the account, not about deciding whether the request may happen.
 */
export async function createSignupAccount(env: CloudflareEnv, input: SignupInput): Promise<SignupOutcome> {
	const usernameCheck = checkSignupUsername(input.username);
	if (!usernameCheck.ok) return { ok: false, status: 400, error: usernameCheck.error };
	const passwordProblem = checkSignupPassword(input.password);
	if (passwordProblem) return { ok: false, status: 400, error: passwordProblem };
	const recovery = checkRecoveryEmail(input.recoveryEmail);
	if (!recovery.ok) return { ok: false, status: 400, error: recovery.error };

	const domain = await getSignupDomain(env);
	if (!domain) {
		return {
			ok: false,
			status: 403,
			error: "Sign-ups are closed: this server has no active domain to hand out addresses from.",
		};
	}

	const username = usernameCheck.username;
	const email = signupAddress(username, domain.hostname);
	const normalized = normalizeRecipientLocalPart(username);
	const db = getDb(env);

	const [takenLogin] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
	if (takenLogin) return { ok: false, status: 409, error: "That username is already taken. Try another one." };

	// Addresses are compared normalized (`.` folded, `+tag` dropped) because that
	// is how inbound routing matches them: `a.b` and `ab` are one mailbox.
	const takenMailboxes = await db
		.select({ localPart: mailboxes.localPart })
		.from(mailboxes)
		.where(eq(mailboxes.domainId, domain.id));
	if (takenMailboxes.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) {
		return { ok: false, status: 409, error: "That username is already taken. Try another one." };
	}
	const takenAliases = await db
		.select({ localPart: mailboxAliases.localPart })
		.from(mailboxAliases)
		.where(eq(mailboxAliases.domainId, domain.id));
	if (takenAliases.some((row) => normalizeRecipientLocalPart(row.localPart) === normalized)) {
		return { ok: false, status: 409, error: "That username is already taken. Try another one." };
	}

	const userId = newId("usr");
	const mailboxId = newId("mbx");
	const mailbox = {
		id: mailboxId,
		userId,
		domainId: domain.id,
		localPart: username,
		displayName: username,
		// Only the address just registered. The mailbox owner has no domains of
		// their own, so "all domains" would silently open the same local part on
		// every domain the operator ever adds.
		useAllDomains: false,
	};
	const changes: CfEmailRoutingRuleChange[] = [];
	let inserted = false;
	try {
		// One batch: the login and its mailbox appear together or not at all.
		await db.batch([
			db.insert(users).values({
				id: userId,
				email,
				resetEmail: recovery.email,
				passwordHash: hashPassword(input.password as string),
				name: username,
				role: "user",
			}),
			db.insert(mailboxes).values(mailbox),
		]);
		inserted = true;
		await ensureBookingUsername(env, userId, email);
		await ensureMailboxDomainRouting(env, db, mailbox, changes);
		return { ok: true, userId, mailboxId, email };
	} catch (error) {
		// `mailboxes.user_id` cascades, so removing the account takes the mailbox
		// with it; the routing rules were created outside the database and need
		// their own undo.
		if (inserted) {
			try {
				await db.delete(users).where(eq(users.id, userId));
			} catch (cleanupError) {
				console.warn("Could not remove the account after a failed sign-up", cleanupError);
			}
		}
		await rollbackEmailRoutingRuleChanges(env, changes).catch((rollbackError) => {
			console.warn("Could not roll back routing rules after a failed sign-up", rollbackError);
		});
		if (isUniqueConstraintError(error)) {
			return { ok: false, status: 409, error: "That username was just taken. Try another one." };
		}
		console.warn("Sign-up failed while provisioning the mailbox", error);
		return {
			ok: false,
			status: 502,
			error: "The account could not be created right now. Please try again in a moment.",
		};
	}
}
