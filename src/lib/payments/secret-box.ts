/**
 * Sealing a user's own provider credentials before they are stored.
 *
 * A Resend key or an SES secret in the database is a key to somebody's sending
 * account: whoever reads the table can send mail as them, and a database dump
 * that ends up in a backup bucket is the usual way that happens. Sealing does not
 * make a dump harmless, but it does make the dump alone useless — the key lives
 * in the Worker's secrets, not next to the ciphertext.
 *
 * AES-GCM with a random IV per record: the IV is stored beside the ciphertext,
 * and the tag is part of what `subtle.decrypt` verifies, so a modified record
 * fails to open instead of opening as garbage.
 *
 * Import-free, and WebCrypto only, so the same code runs in the Worker and in
 * the tests.
 */

export type SealedValue = { v: 1; iv: string; ct: string };

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * The sealing key, derived from the deployment secret.
 *
 * SHA-256 rather than a KDF: the input is an operator-chosen high-entropy secret
 * from `wrangler secret put`, not a passphrase, so there is nothing to stretch.
 */
async function keyFrom(secret: string): Promise<CryptoKey> {
	if (!secret.trim()) throw new Error("No sealing secret is configured");
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
	return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seals a JSON value into a string safe to store in one text column. */
export async function sealJson(secret: string, value: unknown): Promise<string> {
	const key = await keyFrom(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		encoder.encode(JSON.stringify(value)),
	);
	return JSON.stringify({ v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ciphertext)) } satisfies SealedValue);
}

/**
 * Opens a sealed value, or returns null.
 *
 * Null rather than an exception because every caller has the same answer for
 * "cannot read it": the credentials are gone (secret rotated, record truncated),
 * so treat the account as having none and let the person enter a new key. Throwing
 * would turn a rotated secret into a failed send with no explanation.
 */
export async function openJson<T = unknown>(secret: string, sealed: string | null | undefined): Promise<T | null> {
	if (!sealed) return null;
	try {
		const parsed = JSON.parse(sealed) as Partial<SealedValue>;
		if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.ct !== "string") return null;
		const key = await keyFrom(secret);
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: fromBase64(parsed.iv) },
			key,
			fromBase64(parsed.ct),
		);
		return JSON.parse(new TextDecoder().decode(plaintext)) as T;
	} catch {
		return null;
	}
}

/**
 * The last four characters of a secret, for "key ending 4f2a" in the UI. Never
 * enough to use, enough to tell two keys apart.
 */
export function secretHint(secret: string): string {
	const trimmed = secret.trim();
	return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}
