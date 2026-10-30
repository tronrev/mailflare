/**
 * Rules for self-service sign-up, kept free of imports on purpose: the Worker
 * route, the sign-up page and the tests all need exactly these answers, and a
 * module with no dependencies can be reasoned about (and run) on its own.
 */

export const SIGNUP_USERNAME_MIN = 3;
export const SIGNUP_USERNAME_MAX = 30;
export const SIGNUP_PASSWORD_MIN = 8;

/**
 * Lowercase only: the local part of an address is case-insensitive in practice,
 * so accepting `Alice` would create an account nobody can type back reliably.
 * No dots or plus signs either — mail routing folds those away
 * (`normalizeRecipientLocalPart`), which would make `a.b` and `ab` the same
 * mailbox while looking like two.
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Names that must never reach a stranger's hands: role addresses mail servers
 * and people expect to belong to the domain (`postmaster`, `abuse`, `dmarc`),
 * and the ones this product itself uses for mail it sends.
 */
export const SIGNUP_RESERVED_USERNAMES: readonly string[] = [
	"abuse",
	"admin",
	"administrator",
	"billing",
	"contact",
	"dmarc",
	"hostmaster",
	"info",
	"mailer-daemon",
	"marketing",
	"no-reply",
	"noreply",
	"postmaster",
	"privacy",
	"root",
	"security",
	"support",
	"system",
	"webmaster",
];

const reserved = new Set(SIGNUP_RESERVED_USERNAMES);

/** Because mail routing is case-insensitive, so is this. */
export function normalizeSignupUsername(raw: unknown): string {
	return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export type SignupUsernameCheck = { ok: true; username: string } | { ok: false; error: string };

export function checkSignupUsername(raw: unknown): SignupUsernameCheck {
	const username = normalizeSignupUsername(raw);
	if (!username) return { ok: false, error: "Choose a username." };
	if (username.length < SIGNUP_USERNAME_MIN) {
		return { ok: false, error: `Usernames need at least ${SIGNUP_USERNAME_MIN} characters.` };
	}
	if (username.length > SIGNUP_USERNAME_MAX) {
		return { ok: false, error: `Usernames can be at most ${SIGNUP_USERNAME_MAX} characters.` };
	}
	if (!USERNAME_PATTERN.test(username)) {
		return {
			ok: false,
			error: "Use lowercase letters, numbers, hyphens and underscores; start with a letter or number.",
		};
	}
	if (reserved.has(username)) return { ok: false, error: "That username is reserved. Please pick another one." };
	return { ok: true, username };
}

/** The address a new account will sign in with and receive mail at. */
export function signupAddress(username: string, hostname: string): string {
	return `${normalizeSignupUsername(username)}@${hostname.trim().toLowerCase()}`;
}

/**
 * A length floor and nothing else. Composition rules ("one digit, one symbol")
 * are known to push people toward predictable substitutions; length is what
 * actually helps.
 */
export function checkSignupPassword(password: unknown): string | null {
	if (typeof password !== "string" || password.length < SIGNUP_PASSWORD_MIN) {
		return `Passwords need at least ${SIGNUP_PASSWORD_MIN} characters.`;
	}
	if (password.length > 200) return "That password is too long.";
	return null;
}

/**
 * Optional recovery address. Sign-up cannot require one: the person has no
 * working mailbox yet, which is usually the reason they are here.
 */
export function checkRecoveryEmail(raw: unknown): { ok: true; email: string | null } | { ok: false; error: string } {
	if (raw === undefined || raw === null || raw === "") return { ok: true, email: null };
	if (typeof raw !== "string") return { ok: false, error: "Enter a valid email address." };
	const email = raw.trim();
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return { ok: false, error: "Enter a valid email address." };
	}
	return { ok: true, email };
}
