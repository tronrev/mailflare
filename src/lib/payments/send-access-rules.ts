/**
 * The one decision behind "may this account send?".
 *
 * Sending has four ways in and they are not equal: a domain that sends for
 * everyone, an administrator on their own deployment, an account that brought a
 * provider key, and an account that pays for sending time. The settings page,
 * the composer and the send endpoint all have to agree, so the order and the
 * reasons live here rather than in any of them.
 *
 * Kept free of imports so the rule can be tested on its own.
 */

export type SendReason = "domain" | "admin" | "own" | "paid" | null;

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
};

export type SendAccessResult = {
	allowed: boolean;
	reason: SendReason;
};

export function sendAccess(input: SendAccessInput): SendAccessResult {
	// Nothing to send with means nothing to sell: an address on a domain that
	// names no provider waits for its administrator, whoever it is.
	if (input.domainOpenToAll) return { allowed: true, reason: "domain" };
	if (input.admin && input.domainHasProvider) return { allowed: true, reason: "admin" };
	if (input.own) return { allowed: true, reason: "own" };
	if (input.paid && input.hasSystemProvider) return { allowed: true, reason: "paid" };
	return { allowed: false, reason: null };
}
