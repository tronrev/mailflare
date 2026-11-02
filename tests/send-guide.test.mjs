import assert from "node:assert/strict";
import test from "node:test";

const { needsSendGuide } = await import("../src/lib/payments/send-guide.ts");

/**
 * Who gets the "sending is not switched on" guide when they press Compose.
 *
 * The one rule that matters is the administrator exemption: they own the settings
 * that decide this, so a paywall in front of the composer would be noise. The
 * other rule is that an unknown answer is never a refusal — a failed status call
 * must not stop somebody who can send, and `/api/send` refuses on its own.
 */

test("an account that can send is never interrupted", () => {
	assert.equal(needsSendGuide({ allowed: true }), false);
	assert.equal(needsSendGuide({ allowed: true, admin: false }), false);
});

test("a locked account gets the guide", () => {
	assert.equal(needsSendGuide({ allowed: false }), true);
	assert.equal(needsSendGuide({ allowed: false, admin: false }), true);
});

test("administrators are not sold anything", () => {
	assert.equal(needsSendGuide({ allowed: false, admin: true }), false);
});

test("an unanswered status is not a refusal", () => {
	assert.equal(needsSendGuide(null), false);
	assert.equal(needsSendGuide(undefined), false);
});
