import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { getAwsConfig } from "@/lib/aws/config";
import { getOutboundProviderConfig, getResendKeyStatus } from "@/lib/email/outbound-provider";
import type { OutboundProviderConfig } from "@/lib/email/outbound-provider-types";
import { describeCredentials, type OwnCredentials } from "@/lib/payments/credentials";
import { openJson, secretHint } from "@/lib/payments/secret-box";
import { ORDER_MAX_MONTHS, ORDER_MIN_MONTHS, isPaidActive, paidDaysLeft } from "@/lib/payments/usdt-amount";
import { paymentAddress } from "@/lib/payments/orders";

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
	sendProvider: "resend" | "ses" | null;
	sendCredentials: string | null;
	sendCredentialsAt: Date | null;
	sendPaidUntil: Date | null;
	createdAt: Date;
};

/**
 * Whether any address this account owns sits on a domain that sends for everyone.
 *
 * `sendingProvider` says a provider is available; `sendingEnabled` says whether the
 * administrator lets every account use it. A domain with a provider but without
 * `sendingEnabled` is metered: the provider is the pool, but an account has to
 * qualify for it. That distinction is what makes selling sending possible on a
 * deployment that already has a Resend key.
 */
async function domainAllowsSending(env: CloudflareEnv, userId: string): Promise<boolean> {
	const [row] = await getDb(env)
		.select({ id: mailboxes.id })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(
			and(
				eq(mailboxes.userId, userId),
				ne(domains.sendingProvider, "none"),
				eq(domains.sendingEnabled, true),
			),
		)
		.limit(1);
	return !!row;
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
 * deployment's own key when the domain names none). A domain that names a
 * provider but has no key is a misconfiguration and surfaces as itself rather
 * than as "buy sending".
 */
export async function resolveOutboundProvider(
	env: CloudflareEnv,
	options: { userId: string; from: string },
): Promise<OutboundProviderConfig> {
	const domain = await getDomainSending(env, options.from);
	const domainSends = !!domain && domain.provider !== "none";
	if (domainSends && domain.enabled) return getOutboundProviderConfig(env, options.from);

	const account = await getAccountSending(env, options.userId);
	if (!account) throw new Error(SEND_LOCKED_MESSAGE);

	if (account.sendProvider && account.sendCredentials) {
		const credentials = await openJson<OwnCredentials>(env.BILLING_SECRET ?? "", account.sendCredentials);
		if (credentials?.provider === account.sendProvider) return configFromOwn(credentials);
	}

	if (isPaidActive(account.sendPaidUntil, Date.now())) {
		// A metered domain already says which provider it wants; use that one, so a
		// paid month sends the same way the domain would.
		if (domainSends) return getOutboundProviderConfig(env, options.from);
		const paid = await configFromSystem(env);
		if (paid) return paid;
	}
	throw new Error(SEND_LOCKED_MESSAGE);
}

export type SendStatusView = {
	/** Sending works right now, for any of the reasons below. */
	allowed: boolean;
	reason: "domain" | "own" | "paid" | null;
	paidUntil: string | null;
	paidDaysLeft: number;
	own: { provider: "resend" | "ses"; description: string } | null;
	/** The provider a paid month would use; null means buying is not offered here. */
	systemProvider: SystemProvider;
	/** Whether credentials can be sealed at all (`BILLING_SECRET` set). */
	canStoreCredentials: boolean;
	pricePerMonth: number;
	months: { min: number; max: number };
	address: string;
	openOrderId: string | null;
};

/** What the settings page needs to draw the section, and the composer needs to know whether to try. */
export async function getSendStatus(
	env: CloudflareEnv,
	options: { userId: string; openOrderId?: string | null },
): Promise<SendStatusView> {
	const account = await getAccountSending(env, options.userId);
	const domainAllows = await domainAllowsSending(env, options.userId);

	let own: SendStatusView["own"] = null;
	if (account?.sendProvider && account.sendCredentials) {
		const credentials = await openJson<OwnCredentials>(env.BILLING_SECRET ?? "", account.sendCredentials);
		if (credentials) own = { provider: credentials.provider, description: describeCredentials(credentials, secretHint) };
	}

	const paid = isPaidActive(account?.sendPaidUntil, Date.now());
	const systemProvider = await getSystemProvider(env);
	return {
		allowed: domainAllows || !!own || (paid && !!systemProvider),
		reason: domainAllows ? "domain" : own ? "own" : paid && systemProvider ? "paid" : null,
		paidUntil: account?.sendPaidUntil?.toISOString() ?? null,
		paidDaysLeft: paidDaysLeft(account?.sendPaidUntil, Date.now()),
		own,
		systemProvider,
		canStoreCredentials: !!env.BILLING_SECRET?.trim(),
		pricePerMonth: 1,
		months: { min: ORDER_MIN_MONTHS, max: ORDER_MAX_MONTHS },
		address: paymentAddress(env),
		openOrderId: options.openOrderId ?? null,
	};
}
