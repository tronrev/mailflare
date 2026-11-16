/**
 * Completion for the email field on the sign-in screen.
 *
 * A self-hosted deployment hands out addresses on a handful of domains, so
 * typing "root" and having the rest of "root@example.com" appear as ghost text
 * saves a lot of typing. The rules are deliberately narrow:
 *
 *   - only domains this server actually receives mail for are offered;
 *   - the domain serving this page wins, and when the page sits on a
 *     "mail." hostname its parent domain wins over the "mail." one;
 *   - nothing is suggested until the local part has three characters, or the
 *     user types "@" themselves;
 *   - after "@", what the user types is treated as a prefix, and the matching
 *     domain is filled in rather than shown as a list.
 */

export type EmailCompletion = {
	/** The whole address, once accepted. */
	value: string;
	/** What is shown in grey after the text the user already typed. */
	suffix: string;
};

export type SuggestEmailOptions = {
	/** Domains that receive mail here, in the order the caller prefers them. */
	domains: string[];
	/** Hostname of the page, e.g. "mail.example.com". */
	hostname: string;
};

/** Characters needed in the local part before anything is offered. */
const MIN_LOCAL_PART = 3;

function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase();
}

/**
 * The domain this deployment should offer first.
 *
 * "mail.example.com" is the usual place to host this app while the addresses
 * live on "example.com", so the parent domain is tried before the hostname
 * itself. Anything else falls back to the first configured domain.
 */
export function preferredDomain(domains: string[], hostname: string): string | null {
	const available = domains.map(normalizeDomain).filter(Boolean);
	if (available.length === 0) return null;

	const host = hostname.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
	if (host) {
		const labels = host.split(".");
		// A hostname below the apex ("mail.example.com") is the app's address,
		// not necessarily a domain that receives mail.
		const candidates = labels.length > 2 ? [labels.slice(1).join("."), host] : [host];
		for (const candidate of candidates) {
			if (available.includes(candidate)) return candidate;
		}
	}

	return available[0];
}

/**
 * The completion to show for `value`, or null when there is nothing to add.
 *
 * `value` is the raw field content: no trimming, because the suffix is
 * computed as an offset from it.
 */
export function suggestEmailCompletion(value: string, options: SuggestEmailOptions): EmailCompletion | null {
	if (!value || /\s/.test(value)) return null;

	const at = value.indexOf("@");
	if (at < 0) {
		if (value.length < MIN_LOCAL_PART) return null;
		const domain = preferredDomain(options.domains, options.hostname);
		return domain ? build(value, `${value}@${domain}`) : null;
	}

	const local = value.slice(0, at);
	const typed = value.slice(at + 1);
	if (!local || typed.includes("@")) return null;

	// Nothing after the "@" yet: offer the domain this deployment prefers.
	if (typed === "") {
		const domain = preferredDomain(options.domains, options.hostname);
		return domain ? build(value, `${local}@${domain}`) : null;
	}

	// A prefix search, so "root@exa" still lands on "example.com".
	const prefix = typed.toLowerCase();
	const preferred = preferredDomain(options.domains, options.hostname);
	const matches = options.domains
		.map(normalizeDomain)
		.filter((domain) => domain.startsWith(prefix) && domain !== prefix);
	if (matches.length === 0) return null;

	const chosen = preferred && matches.includes(preferred) ? preferred : matches[0];
	return build(value, `${local}@${chosen}`);
}

function build(value: string, completed: string): EmailCompletion | null {
	if (completed.length <= value.length) return null;
	return { value: completed, suffix: completed.slice(value.length) };
}
