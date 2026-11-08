/**
 * The one decision behind "may this account send?".
 *
 * Sending has five ways in and they are not equal: a domain that sends for
 * everyone, an administrator on their own deployment, an account that brought a
 * provider key, an account that pays for sending time, and — new — the free
 * allowance: a few messages a day out of the deployment's own credentials.
 *
 * The allowance meters the two ways in that cost the person nothing: an open
 * domain, and the deployment's provider. Those are the same money either way —
 * the administrator's Resend or SES account — so "three in the last 24 hours"
 * applies to both, and running out is what turns a free account into a customer.
 * An own key, a paid month and an administrator are not metered: they are not
 * spending the deployment's sending quota.
 *
 * The settings page, the composer and the send endpoint all have to agree, so
 * the order and the reasons live here rather than in any of them.
 *
 * Kept free of imports so the rule can be tested on its own.
 */

export type SendReason = "domain" | "admin" | "own" | "paid" | "free" | null;

export type SendAccessInput = {
	/** An administrator of this deployment. They own the switch, so it does not meter them. */
	admin: boolean;
	/** One of the account's addresses sits on a domain with a sending provider at all. */
	domainHasProvider: boolean;
	/** …and that domain lets every account use it. */
	domainOpenToAll: boolean;
	/** The account stored its own Resend or Amazon SES credentials. */
	own: boolean;
	/** A paid month is still running. */
	paid: boolean;
	/** The deployment itself has a provider to spend a paid month on. */
	hasSystemProvider: boolean;
	/** Free messages left in the sliding 24-hour window. */
	freeRemaining: number;
};

export type SendAccessResult = {
	allowed: boolean;
	reason: SendReason;
};

export function sendAccess(input: SendAccessInput): SendAccessResult {
	const freeLeft = input.freeRemaining > 0;

	// An open domain is reported as the domain — the answer to "whose provider is
	// this?" — not as the administrator who switched it on. The allowance still
	// bounds it for everyone else; the administrator is exempt because the bill
	// being capped is their own.
	if (input.domainOpenToAll && input.domainHasProvider) {
		if (freeLeft || input.admin) return { allowed: true, reason: "domain" };
	}

	// Nothing to send with means nothing to sell: an address on a domain that
	// names no provider waits for its administrator, whoever it is.
	if (input.admin && input.domainHasProvider) return { allowed: true, reason: "admin" };
	if (input.own) return { allowed: true, reason: "own" };
	if (input.paid && input.hasSystemProvider) return { allowed: true, reason: "paid" };
	if (input.hasSystemProvider && freeLeft) return { allowed: true, reason: "free" };
	return { allowed: false, reason: null };
}
