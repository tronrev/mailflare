import assert from "node:assert/strict";
import test from "node:test";

const { sendAccess } = await import("../src/lib/payments/send-access-rules.ts");

/**
 * Who may send, and why.
 *
 * The rule exists so the settings page, the composer and `/api/send` cannot
 * disagree, and the cases worth stating out loud are here: an administrator is
 * never metered, an address on a domain with no provider at all is not "buy
 * sending time" (there is nothing to send with, so nobody is sold anything), and
 * the free allowance meters the two ways in that cost the deployment money — an
 * open domain and its own provider.
 */

const locked = {
	admin: false,
	domainHasProvider: false,
	domainOpenToAll: false,
	own: false,
	paid: false,
	hasSystemProvider: false,
	freeRemaining: 0,
};

test("a domain that sends for everyone needs no other reason", () => {
	assert.deepEqual(sendAccess({ ...locked, domainHasProvider: true, domainOpenToAll: true, freeRemaining: 2 }), {
		allowed: true,
		reason: "domain",
	});
});

test("an open domain is metered by the allowance like any other free way in", () => {
	// The domain says "included", but it is included *out of the administrator's
	// provider*: a few messages a day, then the same two ways out as everyone.
	assert.deepEqual(sendAccess({ ...locked, domainHasProvider: true, domainOpenToAll: true, freeRemaining: 0 }), {
		allowed: false,
		reason: null,
	});
	// …and an administrator is still exempt, because it is their bill.
	assert.deepEqual(sendAccess({ ...locked, admin: true, domainHasProvider: true, domainOpenToAll: true }), {
		allowed: true,
		reason: "domain",
	});
});

test("the deployment's own provider is the free allowance for everyone else", () => {
	assert.deepEqual(sendAccess({ ...locked, hasSystemProvider: true, freeRemaining: 3 }), {
		allowed: true,
		reason: "free",
	});
	assert.deepEqual(sendAccess({ ...locked, hasSystemProvider: true, freeRemaining: 0 }), {
		allowed: false,
		reason: null,
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

test("an own key is not spending the allowance", () => {
	// Whoever pays their own provider has no reason to wait for a slot.
	assert.deepEqual(sendAccess({ ...locked, own: true, freeRemaining: 0 }), { allowed: true, reason: "own" });
});

test("a paid month needs a provider to spend it on", () => {
	assert.deepEqual(sendAccess({ ...locked, paid: true, hasSystemProvider: true }), { allowed: true, reason: "paid" });
	assert.deepEqual(sendAccess({ ...locked, paid: true }), { allowed: false, reason: null });
});

test("a paid month does not wait for the free allowance either", () => {
	assert.deepEqual(sendAccess({ ...locked, paid: true, hasSystemProvider: true, freeRemaining: 0 }), {
		allowed: true,
		reason: "paid",
	});
});

test("an open domain is reported as the domain, not as the person running it", () => {
	assert.equal(
		sendAccess({ ...locked, admin: true, domainHasProvider: true, domainOpenToAll: true, freeRemaining: 1 }).reason,
		"domain",
	);
});
