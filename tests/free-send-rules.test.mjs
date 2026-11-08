import assert from "node:assert/strict";
import test from "node:test";

const { FREE_SENDS_PER_WINDOW, FREE_SEND_WINDOW_MS, SEND_QUOTA_MESSAGE, freeSendState } = await import(
	"../src/lib/payments/free-send-rules.ts"
);

/**
 * The free allowance: three messages a day out of the deployment's own provider.
 *
 * The arithmetic is the whole feature — "three in 24 hours" that resets at
 * midnight hands out six around the boundary, and a window that closes a
 * millisecond early gives back a slot nobody spent. Both are tested here.
 */

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

test("an account that has not sent anything has the whole allowance", () => {
	assert.deepEqual(freeSendState([], NOW), {
		limit: FREE_SENDS_PER_WINDOW,
		used: 0,
		remaining: FREE_SENDS_PER_WINDOW,
		exhausted: false,
		nextSlotAt: null,
	});
});

test("the window slides: only the last 24 hours count", () => {
	const times = [NOW - 25 * HOUR, NOW - 23 * HOUR, NOW - 2 * HOUR];
	const state = freeSendState(times, NOW);
	assert.equal(state.used, 2, "the 25-hour-old message is spent");
	assert.equal(state.remaining, FREE_SENDS_PER_WINDOW - 2);
	assert.equal(state.exhausted, false);
});

test("a slot comes back exactly 24 hours after it was spent", () => {
	const spent = NOW - FREE_SEND_WINDOW_MS + 1;
	const times = [NOW - FREE_SEND_WINDOW_MS - 1, spent, NOW - 2 * HOUR, NOW - HOUR];
	assert.equal(freeSendState(times, NOW).used, 3, "the one just outside the window is spent");
	assert.equal(freeSendState(times, NOW).remaining, 0);

	// The oldest send inside the window returns one window after it happened —
	// not at midnight, and not 24 hours after the *last* send.
	const later = spent + FREE_SEND_WINDOW_MS - 1;
	assert.equal(freeSendState(times, later).remaining, 0, "one millisecond early is still spent");
	assert.equal(freeSendState(times, later + 1).remaining, 1);
});

test("a full allowance says when the first slot returns", () => {
	const state = freeSendState([NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR], NOW);
	assert.equal(state.exhausted, true);
	assert.equal(state.remaining, 0);
	assert.equal(state.nextSlotAt, new Date(NOW - 3 * HOUR + FREE_SEND_WINDOW_MS).toISOString());
});

test("a timestamp in the future is not counted", () => {
	// A clock skew between Workers instances must not eat a slot that has not
	// happened yet.
	const state = freeSendState([NOW + HOUR, NOW - HOUR], NOW);
	assert.equal(state.used, 1);
});

test("the refusal names the limit and the window", () => {
	assert.match(SEND_QUOTA_MESSAGE, new RegExp(String(FREE_SENDS_PER_WINDOW)));
	assert.match(SEND_QUOTA_MESSAGE, /24 hours/);
	assert.match(SEND_QUOTA_MESSAGE, /Settings/);
});
