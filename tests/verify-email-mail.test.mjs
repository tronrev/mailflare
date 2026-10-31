import assert from "node:assert/strict";
import test from "node:test";

const mail = await import("../src/lib/auth/verify-email-mail.ts");

/**
 * The confirmation mail is the only thing standing between "anyone can type an
 * address into the form" and "the account belongs to whoever reads that inbox",
 * so what it says and where it points are worth pinning: a wrong link means
 * every sign-up dies silently 24 hours later.
 */
function translator(overrides = {}) {
	const table = {
		"auth.verifyMail.subject": "Confirm your {appName} address",
		"auth.verifyMail.intro": "You asked to open {email} on {appName}.",
		"auth.verifyMail.instructions": "Open this link within {hours} hours to activate the address:",
		"auth.resetMail.ignore": "If that was not you, ignore this message.",
		...overrides,
	};
	return (key, params = {}) =>
		String(table[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

const link = "https://mail.example.com/api/auth/verify-email?token=evt_abc";

test("the mail names the address, the app and the deadline", () => {
	const built = mail.buildVerificationEmail(translator(), {
		email: "alice@example.com",
		appName: "Mailflare",
		link,
		hours: 24,
	});
	assert.equal(built.subject, "Confirm your Mailflare address");
	assert.match(built.text, /You asked to open alice@example\.com on Mailflare\./);
	assert.match(built.text, /within 24 hours/);
	assert.ok(built.text.includes(link), "the plain-text body must carry the clickable link");
	assert.ok(built.html.includes(`href="${link}"`), "the HTML body must link to the same place");
});

test("the link is escaped before it reaches HTML", () => {
	const built = mail.buildVerificationEmail(translator(), {
		email: "alice@example.com",
		appName: "Mailflare",
		link: 'https://mail.example.com/x?token=a"b&c',
		hours: 24,
	});
	assert.ok(built.html.includes("&quot;"), "quotes in the link must be escaped");
	assert.ok(!built.html.includes('token=a"b'), "an unescaped quote would break out of the attribute");
});

test("a missing translation shows up instead of silently emptying the mail", () => {
	// i18n parity is enforced separately; this guards the case where a new key
	// lands in en.json only, because a blank body looks like a delivery failure.
	const built = mail.buildVerificationEmail(translator({ "auth.verifyMail.instructions": undefined }), {
		email: "alice@example.com",
		appName: "Mailflare",
		link,
		hours: 24,
	});
	assert.match(built.text, /auth\.verifyMail\.instructions/);
});

