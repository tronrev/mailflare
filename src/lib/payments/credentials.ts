/**
 * The provider credentials an account can bring instead of paying.
 *
 * Two shapes are accepted, and the checks are here rather than in the route so
 * the same rules decide what is accepted and what a test can prove. The values
 * are the ones the provider itself needs, nothing renamed: a person pasting a
 * Resend key or an SES pair should recognise what they handed over.
 *
 * Import-free.
 */

export type OwnProvider = "resend" | "ses";

export type OwnCredentials =
	| { provider: "resend"; apiKey: string }
	| { provider: "ses"; accessKeyId: string; secretAccessKey: string; region: string };

export type CredentialCheck = { ok: true; value: OwnCredentials } | { ok: false; error: string };

/** Same pattern the admin-side AWS settings accept, kept local so this module needs no import. */
const REGION_PATTERN = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

const RESEND_KEY_PATTERN = /^re_[A-Za-z0-9_-]{8,}$/;

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads a submitted credential.
 *
 * Resend keys are shape-checked before anything is stored: `re_` is the prefix
 * Resend issues, so a pasted AWS key or an empty box is refused here rather than
 * discovered on the first send. SES has no fixed shape, so only length and the
 * region are checked — the provider itself is the authority on whether they work.
 */
export function readCredentials(provider: unknown, input: Record<string, unknown> | null | undefined): CredentialCheck {
	const body = input ?? {};
	if (provider === "resend") {
		const apiKey = text(body.apiKey);
		if (!apiKey) return { ok: false, error: "Paste the Resend API key" };
		if (apiKey.length > 500) return { ok: false, error: "That key is too long to be a Resend API key" };
		if (!RESEND_KEY_PATTERN.test(apiKey)) {
			return { ok: false, error: "A Resend API key starts with re_ — check what was pasted" };
		}
		return { ok: true, value: { provider: "resend", apiKey } };
	}
	if (provider === "ses") {
		const accessKeyId = text(body.accessKeyId);
		const secretAccessKey = text(body.secretAccessKey);
		const region = text(body.region);
		if (!accessKeyId || !secretAccessKey) return { ok: false, error: "Enter both the SES access key ID and the secret access key" };
		if (!REGION_PATTERN.test(region)) return { ok: false, error: "Enter the SES region, for example us-east-1" };
		if (accessKeyId.length > 200 || secretAccessKey.length > 200) return { ok: false, error: "That key is too long to be an SES key" };
		return { ok: true, value: { provider: "ses", accessKeyId, secretAccessKey, region } };
	}
	return { ok: false, error: "Choose Resend or Amazon SES" };
}

/** "Resend, key ending 4f2a" — enough to recognise which key is installed. */
export function describeCredentials(credentials: OwnCredentials, hint: (secret: string) => string): string {
	if (credentials.provider === "resend") return `Resend, key ending ${hint(credentials.apiKey).replace(/^••••/, "")}`;
	return `Amazon SES, ${credentials.region}, key ending ${hint(credentials.accessKeyId).replace(/^••••/, "")}`;
}
