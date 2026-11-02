import assert from "node:assert/strict";
import test from "node:test";

const { sendAccess } = await import("../src/lib/payments/send-access-rules.ts");

/**
 * Who may send, and why.
 *
 * The rule exists so the settings page, the composer and `/api/send` cannot
 * disagree, and the two cases worth stating out loud are here: an administrator
 * is never metered, and an address on a domain with no provider at all is not
 * "buy sending time" — there is nothing to send with, so nobody is sold anything.
 */

const locked = {
	admin: false,
	domainHasProvider: false,
	domainOpenToAll: false,
	own: false,
	paid: false,
	hasSystemProvider: false,
};

test("a domain that sends for everyone needs no other reason", () => {
	assert.deepEqual(sendAccess({ ...locked, domainHasProvider: true, domainOpenToAll: true }), {
		allowed: true,
		reason: "domain",
	});
});

test("an administrator sends through their own domain even when it is metered", () => {
	// The case that motivated this: `sendingEnabled = false` means "everyone else
	// pays", not "the person who set the deployment up cannot use their mail".
	assert.deepEqual(sendAccess({ ...locked, admin: true, domainHasProvider: true }), {
		allowed: true,
		reason: "admin",
	});
});

test("an administrator with no sending provider is as stuck as anybody", () => {
	assert.deepEqual(sendAccess({ ...locked, admin: true }), { allowed: false, reason: null });
});

test("an own key works without a domain, an administrator or a payment", () => {
	assert.deepEqual(sendAccess({ ...locked, own: true }), { allowed: true, reason: "own" });
});

test("a paid month needs a provider to spend it on", () => {
	assert.deepEqual(sendAccess({ ...locked, paid: true, hasSystemProvider: true }), { allowed: true, reason: "paid" });
	assert.deepEqual(sendAccess({ ...locked, paid: true }), { allowed: false, reason: null });
});

test("an open domain is reported as the domain, not as the person running it", () => {
	assert.equal(sendAccess({ ...locked, admin: true, domainHasProvider: true, domainOpenToAll: true }).reason, "domain");
});
