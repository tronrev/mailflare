import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { getAwsConfig } from "@/lib/aws/config";
import { describeDatabaseError } from "@/lib/database-errors";
import { getOutboundProviderConfig, getResendKeyStatus } from "@/lib/email/outbound-provider";
import type { OutboundProviderConfig } from "@/lib/email/outbound-provider-types";
import { describeCredentials, type OwnCredentials } from "@/lib/payments/credentials";
import { openJson, secretHint } from "@/lib/payments/secret-box";
import { paymentAddress } from "@/lib/payments/orders";
import { claimFreeSend, readFreeSendState } from "@/lib/payments/free-sends";
import { FREE_SENDS_PER_WINDOW, SEND_QUOTA_MESSAGE, type FreeSendState } from "@/lib/payments/free-send-rules";
import { sendAccess, type SendReason } from "@/lib/payments/send-access-rules";
import { ORDER_MAX_MONTHS, ORDER_MIN_MONTHS, isPaidActive, paidDaysLeft, paidUntilIso } from "@/lib/payments/usdt-amount";

/**
 * Who is allowed to send mail, and through what.
 *
 * Two answers, in this order:
 *
 * 1. The domain says it can send (an administrator set up Cloudflare Email
 *    Sending, Resend or SES for it). Then everyone with a mailbox there can send,
 *    as before — this feature adds a way in, it does not take one away.
 * 2. The domain is receive-only. Then the account itself has to qualify: either
 *    it brought its own provider credentials, or it is paying for sending time
 *    and the deployment has a provider to spend it on.
 *
 * A receive-only domain with no system provider cannot sell anything, so the
 * status says so instead of taking money for a service that cannot be delivered.
 */

/** The one message every refusal ends with, so the UI and the API agree. */
export const SEND_LOCKED_MESSAGE =
	"Sending is not enabled for this address. Add your own Resend or Amazon SES key, or buy sending time, in Settings → Sending.";

export type SystemProvider = "resend" | "ses" | null;

/** The provider a paid month would be spent on: the deployment's own credentials. */
export async function getSystemProvider(env: CloudflareEnv): Promise<SystemProvider> {
	const resend = await getResendKeyStatus(env);
	if (resend.apiKey) return "resend";
	const aws = await getAwsConfig(env).catch(() => null);
	return aws ? "ses" : null;
}

function configFromOwn(credentials: OwnCredentials): OutboundProviderConfig {
	if (credentials.provider === "resend") return { provider: "resend", apiKey: credentials.apiKey };
	return {
		provider: "ses",
		config: {
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			region: credentials.region,
		},
	};
}

async function configFromSystem(env: CloudflareEnv): Promise<OutboundProviderConfig | null> {
	const system = await getSystemProvider(env);
	if (system === "resend") {
		const { apiKey } = await getResendKeyStatus(env);
		return apiKey ? { provider: "resend", apiKey } : null;
	}
	if (system === "ses") {
		const config = await getAwsConfig(env).catch(() => null);
		return config ? { provider: "ses", config } : null;
	}
	return null;
}

type AccountSending = {
	role: "admin" | "user";
	sendProvider: "resend" | "ses" | null;
	sendCredentials: string | null;
	sendCredentialsAt: Date | null;
	sendPaidUntil: Date | null;
	createdAt: Date;
};

/**
 * What the account's own addresses can do, reduced to the two facts that matter.
 *
 * `sendingProvider` says a provider exists; `sendingEnabled` says whether the
 * administrator lets every account use it. A domain with a provider but without
 * `sendingEnabled` is metered: the provider is the pool, but an account has to
 * qualify for it. That distinction is what makes selling sending possible on a
 * deployment that already has a Resend key.
 *
 * Both facts are returned together because they answer two different questions —
 * "may this account send?" ignores `sendingEnabled` for an administrator, while
 * everyone else needs it — and computing them from one read keeps the two
 * answers impossible to disagree.
 *
 * Two plain lookups rather than a join: the joined query was the one thing the
 * production database could not answer, and a mailbox's domain is cheap to fetch
 * on its own.
 */
async function accountDomains(
	env: CloudflareEnv,
	userId: string,
): Promise<{ hasProvider: boolean; openToAll: boolean }> {
	const owned = await getDb(env)
		.select({ domainId: mailboxes.domainId })
		.from(mailboxes)
		.where(eq(mailboxes.userId, userId));
	const domainIds = [...new Set(owned.map((row) => row.domainId).filter((id): id is string => !!id))];
	if (domainIds.length === 0) return { hasProvider: false, openToAll: false };

	// One lookup per owned domain rather than one `in (…)` list. It is the query
	// the rest of the app already runs against this database — `getMailboxDomainAddresses`
	// reads a domain by id on every inbox load — and an account owns a handful.
	const sending = (
		await Promise.all(
			domainIds.map(async (domainId): Promise<{ provider: "none" | "cloudflare" | "resend" | "ses"; enabled: boolean } | null> => {
				const [row] = await getDb(env)
					.select({ provider: domains.sendingProvider, enabled: domains.sendingEnabled })
					.from(domains)
					.where(eq(domains.id, domainId))
					.limit(1);
				return row ?? null;
			}),
		)
	).filter((row): row is { provider: "none" | "cloudflare" | "resend" | "ses"; enabled: boolean } => !!row);

	return {
		hasProvider: sending.some((row) => row.provider !== "none"),
		openToAll: sending.some((row) => row.provider !== "none" && row.enabled),
	};
}

/** The sending setup of the domain an address belongs to, if any. */
async function getDomainSending(
	env: CloudflareEnv,
	from: string,
): Promise<{ provider: "none" | "cloudflare" | "resend" | "ses"; enabled: boolean } | null> {
	const hostname = from.split("@")[1]?.toLowerCase();
	if (!hostname) return null;
	const [row] = await getDb(env)
		.select({ provider: domains.sendingProvider, enabled: domains.sendingEnabled })
		.from(domains)
		.where(eq(domains.hostname, hostname))
		.limit(1);
	return row ?? null;
}

export async function getAccountSending(env: CloudflareEnv, userId: string): Promise<AccountSending | null> {
	const [row] = await getDb(env)
		.select({
			role: users.role,
			sendProvider: users.sendProvider,
			sendCredentials: users.sendCredentials,
			sendCredentialsAt: users.sendCredentialsAt,
			sendPaidUntil: users.sendPaidUntil,
			createdAt: users.createdAt,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row ?? null;
}

/**
 * The provider to send this account's mail through, or a refusal.
 *
 * In order: a domain that sends for everyone; the account's own credentials; a
 * paid month, spent through whichever provider the domain names (or the
 * deployment's own key when the domain names none); and finally the free
 * allowance, which is the deployment's provider for a few messages a day. A
 * domain that names a provider but has no key is a misconfiguration and surfaces
 * as itself rather than as "buy sending".
 *
 * The two free ways in spend a slot of the allowance before the message goes
 * out, so the answer carries the slot's id: a send that the provider then refuses
 * gives it back (`releaseFreeSend`).
 */
export type ResolvedOutboundProvider = {
	config: OutboundProviderConfig;
	/** Set when this send spent one of the free allowance's slots. */
	freeUseId?: string;
};

async function spendFreeSlot(
	env: CloudflareEnv,
	options: { userId: string },
	config: OutboundProviderConfig,
): Promise<ResolvedOutboundProvider> {
	const claim = await claimFreeSend(env, { userId: options.userId, provider: config.provider });
	if (!claim) throw new Error(SEND_QUOTA_MESSAGE);
	return { config, freeUseId: claim.id };
}

export async function resolveOutboundProvider(
	env: CloudflareEnv,
	options: { userId: string; from: string },
): Promise<ResolvedOutboundProvider> {
	const domain = await getDomainSending(env, options.from);
	const domainSends = !!domain && domain.provider !== "none";
	if (domainSends && domain.enabled) {
		const config = await getOutboundProviderConfig(env, options.from);
		const owner = await getAccountSending(env, options.userId);
		// An administrator owns the switch that decides whether a domain is metered,
		// so it does not meter them. Without this the person who set the deployment
		// up could not send from their own address until they bought time from
		// themselves, which is not a thing.
		if (owner?.role === "admin") return { config };
		return spendFreeSlot(env, options, config);
	}

	const account = await getAccountSending(env, options.userId);
	if (!account) throw new Error(SEND_LOCKED_MESSAGE);

	if (domainSends && account.role === "admin") return { config: await getOutboundProviderConfig(env, options.from) };

	if (account.sendProvider && account.sendCredentials) {
		const credentials = await openJson<OwnCredentials>(env.BILLING_SECRET ?? "", account.sendCredentials);
		if (credentials?.provider === account.sendProvider) return { config: configFromOwn(credentials) };
	}

	if (isPaidActive(account.sendPaidUntil, Date.now())) {
		// A metered domain already says which provider it wants; use that one, so a
		// paid month sends the same way the domain would.
		if (domainSends) return { config: await getOutboundProviderConfig(env, options.from) };
		const paid = await configFromSystem(env);
		if (paid) return { config: paid };
	}

	// The free allowance: the deployment's own provider, a few messages a day.
	const free = await configFromSystem(env);
	if (free) return spendFreeSlot(env, options, free);
	throw new Error(SEND_LOCKED_MESSAGE);
}

export type SendStatusView = {
	/** Sending works right now, for any of the reasons below. */
	allowed: boolean;
	/** Why: the domain, an administrator, their own key, or a paid month. */
	reason: SendReason;
	/**
	 * An administrator. Nothing is sold to them: they own the settings that decide
	 * whether this deployment sends at all, so a paywall would only be noise.
	 */
	admin: boolean;
	paidUntil: string | null;
	paidDaysLeft: number;
	own: { provider: "resend" | "ses"; description: string } | null;
	/** The provider a paid month spends the deployment's own credentials on. */
	systemProvider: SystemProvider;
	/**
	 * The free allowance — messages a day out of the deployment's own provider.
	 * Null when it could not be read, which is not the same as "none left".
	 */
	free: FreeSendState | null;
	/** Buying needs both a provider to spend the money on and an address to send it to. */
	buyingOffered: boolean;
	/** Whether credentials can be sealed at all (`BILLING_SECRET` set). */
	canStoreCredentials: boolean;
	pricePerMonth: number;
	months: { min: number; max: number };
	address: string;
	openOrderId: string | null;
	/**
	 * The reads that failed, by name, with the database's own words.
	 *
	 * A page that answers "sending is not enabled" because one query could not be
	 * answered is indistinguishable from one where that is the truth, and from
	 * outside the Worker both look like an empty 500. So a failed read degrades
	 * only itself: the rest of the answer stands, and what broke is named here and
	 * on the page. Absent means every part was read.
	 */
	problems?: Record<string, string>;
};

/**
 * Run one part of the answer, and lose only that part if it fails.
 *
 * `getSendStatus` spans four reads that have nothing to do with each other: the
 * account row, the domains behind its addresses, the deployment's provider, and
 * the address money goes to. Any one of them failing used to take the whole
 * section down with it, which is how a missing table turned into "could not load
 * sending settings" with no way to tell what was missing.
 */
async function guarded<T>(
	problems: Record<string, string>,
	stage: string,
	fallback: T,
	read: () => Promise<T>,
): Promise<T> {
	try {
		return await read();
	} catch (error) {
		const message = describeDatabaseError(error);
		problems[stage] = message;
		console.error(`[billing] sending ${stage} unavailable:`, message);
		return fallback;
	}
}

/** What the settings page needs to draw the section, and the composer needs to know whether to try. */
export async function getSendStatus(
	env: CloudflareEnv,
	options: { userId: string; openOrderId?: string | null },
): Promise<SendStatusView> {
	const problems: Record<string, string> = {};
	const account = await guarded(problems, "account", null, () => getAccountSending(env, options.userId));
	const ownDomains = await guarded(problems, "addresses", { hasProvider: false, openToAll: false }, () =>
		accountDomains(env, options.userId),
	);

	let own: SendStatusView["own"] = null;
	if (account?.sendProvider && account.sendCredentials) {
		const credentials = await guarded(problems, "credentials", null, () =>
			openJson<OwnCredentials>(env.BILLING_SECRET ?? "", account.sendCredentials),
		);
		if (credentials) own = { provider: credentials.provider, description: describeCredentials(credentials, secretHint) };
	}

	const paid = isPaidActive(account?.sendPaidUntil, Date.now());
	const systemProvider = await guarded(problems, "provider", null as SystemProvider, () => getSystemProvider(env));
	const address = await guarded(problems, "address", "", async () => paymentAddress(env));
	// A failed read must not read as "you are out": the allowance is unknown, so it
	// is reported as unknown (null) and the rule is told the full limit — `/api/send`
	// refuses on its own when the read works and there is nothing left.
	const free = await guarded(problems, "allowance", null as FreeSendState | null, () =>
		readFreeSendState(env, options.userId),
	);
	const access = sendAccess({
		admin: account?.role === "admin",
		domainHasProvider: ownDomains.hasProvider,
		domainOpenToAll: ownDomains.openToAll,
		own: !!own,
		paid,
		hasSystemProvider: !!systemProvider,
		freeRemaining: free ? free.remaining : FREE_SENDS_PER_WINDOW,
	});
	return {
		allowed: access.allowed,
		reason: access.reason,
		admin: account?.role === "admin",
		paidUntil: paidUntilIso(account?.sendPaidUntil),
		paidDaysLeft: paidDaysLeft(account?.sendPaidUntil, Date.now()),
		own,
		systemProvider,
		free,
		buyingOffered: !!systemProvider && address !== "",
		canStoreCredentials: !!env.BILLING_SECRET?.trim(),
		pricePerMonth: 1,
		months: { min: ORDER_MIN_MONTHS, max: ORDER_MAX_MONTHS },
		address,
		openOrderId: options.openOrderId ?? null,
		...(Object.keys(problems).length > 0 ? { problems } : {}),
	};
}
