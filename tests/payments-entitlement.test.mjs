import assert from "node:assert/strict";
import test from "node:test";

const amount = await import("../src/lib/payments/usdt-amount.ts");
const box = await import("../src/lib/payments/secret-box.ts");
const creds = await import("../src/lib/payments/credentials.ts");

/**
 * Sending time and provider credentials. The arithmetic here decides when someone
 * can send and what they are charged; the sealing decides whether a database dump
 * hands out other people's sending accounts.
 */

test("a paid period extends the one already running instead of restarting it", () => {
	const now = new Date("2026-10-30T12:00:00Z");
	// Nothing running: a month starts now and ends 30 days later.
	assert.equal(amount.paidUntilAfter(null, 1, now).toISOString(), "2026-11-29T12:00:00.000Z");
	// Renewing early keeps what is left: 10 days left + 12 bought months.
	const early = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
	assert.equal(amount.paidUntilAfter(early, 12, now).toISOString(), "2027-11-04T12:00:00.000Z");
	// Renewing late counts from now, not from a timestamp in the past.
	const lapsed = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
	assert.equal(amount.paidUntilAfter(lapsed, 1, now).toISOString(), "2026-11-29T12:00:00.000Z");
});

test("paid is a moment in time, not a flag", () => {
	const now = new Date("2026-10-30T12:00:00Z");
	assert.equal(amount.isPaidActive(null, now), false);
	assert.equal(amount.isPaidActive(undefined, now), false);
	assert.equal(amount.isPaidActive(new Date(now.getTime() - 1), now), false);
	// Exactly now is over: the send that happens this second is not covered.
	assert.equal(amount.isPaidActive(new Date(now.getTime()), now), false);
	assert.equal(amount.isPaidActive(new Date(now.getTime() + 1), now), true);
	assert.equal(amount.paidDaysLeft(new Date(now.getTime() + 36 * 60 * 60 * 1000), now), 2);
	assert.equal(amount.paidDaysLeft(new Date(now.getTime() - 1), now), 0);
	assert.equal(amount.paidDaysLeft(null, now), 0);
});

test("sealed credentials survive a round trip and nothing else", async () => {
	const secret = "test-sealing-secret";
	const original = { provider: "resend", apiKey: "re_live_abcdefgh1234" };
	const sealed = await box.sealJson(secret, original);
	assert.notEqual(sealed, JSON.stringify(original));
	assert.equal(sealed.includes("re_live"), false, "the key must not be readable in the stored value");
	assert.deepEqual(await box.openJson(secret, sealed), original);

	// A different secret is a different key: a rotated secret must fail closed.
	assert.equal(await box.openJson("another-secret", sealed), null);
	// Tampering breaks the tag rather than returning modified data.
	const parsed = JSON.parse(sealed);
	const flip = { ...parsed, ct: `${parsed.ct.slice(0, -4)}AAAA` };
	assert.equal(await box.openJson(secret, JSON.stringify(flip)), null);
	for (const bad of [null, undefined, "", "not json", "{}", JSON.stringify({ v: 2, iv: "a", ct: "b" })]) {
		assert.equal(await box.openJson(secret, bad), null, String(bad));
	}
	// Same input twice must not produce the same ciphertext: the IV is fresh.
	assert.notEqual(await box.sealJson(secret, original), sealed);
});

test("a hint shows the tail of a key and never the key", () => {
	assert.equal(box.secretHint("re_live_abcdefgh1234"), "••••1234");
	assert.equal(box.secretHint("  re_abcd  "), "••••abcd");
	assert.equal(box.secretHint("abc"), "••••");
});

test("Resend keys are shape-checked before they are stored", () => {
	const ok = creds.readCredentials("resend", { apiKey: "  re_1234567890ab  " });
	assert.equal(ok.ok, true);
	if (ok.ok) assert.deepEqual(ok.value, { provider: "resend", apiKey: "re_1234567890ab" });

	for (const bad of ["", "   ", "AKIAIOSFODNN7EXAMPLE", "sk_live_x", `re_${"a".repeat(600)}`]) {
		const check = creds.readCredentials("resend", { apiKey: bad });
		assert.equal(check.ok, false, bad);
	}
	// A missing body is an error, not a crash.
	assert.equal(creds.readCredentials("resend", null).ok, false);
});

test("SES credentials need both halves and a real region", () => {
	const ok = creds.readCredentials("ses", { accessKeyId: " AKIA123 ", secretAccessKey: " s3cret ", region: "eu-west-1" });
	assert.equal(ok.ok, true);
	if (ok.ok) assert.deepEqual(ok.value, { provider: "ses", accessKeyId: "AKIA123", secretAccessKey: "s3cret", region: "eu-west-1" });

	assert.equal(creds.readCredentials("ses", { accessKeyId: "AKIA123", region: "eu-west-1" }).ok, false);
	assert.equal(creds.readCredentials("ses", { accessKeyId: "AKIA123", secretAccessKey: "s", region: "europe" }).ok, false);
	assert.equal(creds.readCredentials("ses", { accessKeyId: "AKIA123", secretAccessKey: "s", region: "us-gov-west-1" }).ok, true);
	assert.equal(creds.readCredentials("smtp", { apiKey: "x" }).ok, false);
});

test("the description says which provider and which key, not the key itself", () => {
	const resend = creds.readCredentials("resend", { apiKey: "re_abcdefgh1234" });
	assert.equal(resend.ok, true);
	if (resend.ok) assert.equal(creds.describeCredentials(resend.value, box.secretHint), "Resend, key ending 1234");

	const ses = creds.readCredentials("ses", { accessKeyId: "AKIA123", secretAccessKey: "s", region: "us-east-1" });
	assert.equal(ses.ok, true);
	if (ses.ok) assert.equal(creds.describeCredentials(ses.value, box.secretHint), "Amazon SES, us-east-1, key ending A123");
});
