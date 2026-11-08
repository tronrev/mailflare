/**
 * The free allowance: how many messages an account may send in a rolling day
 * before it has to bring a provider key or buy time.
 *
 * The deployment pays for these — they go out through the administrator's own
 * Resend or SES credentials — so the number is small and the window slides
 * rather than resetting at midnight: "three today" would hand out six in ten
 * minutes around 00:00, and the point is a taste of sending, not a daily gift.
 *
 * Kept free of imports so the arithmetic can be tested on its own.
 */

/** Messages an account may send through the deployment's provider in one window. */
export const FREE_SENDS_PER_WINDOW = 3;

/** The window slides: a slot comes back exactly 24 hours after it was spent. */
export const FREE_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The refusal an exhausted account gets, word for word, from `/api/send`.
 *
 * The number is in it because "you are over the limit" without saying which
 * limit reads as a bug; `24 hours` is in it because the slot comes back on its
 * own and nobody should think they have to wait for a reset at midnight.
 */
export const SEND_QUOTA_MESSAGE =
	`This account has used its ${FREE_SENDS_PER_WINDOW} free messages in the last 24 hours. ` +
	"Add your own Resend or Amazon SES key, or buy sending time, in Settings → Sending.";

export type FreeSendState = {
	limit: number;
	/** Sends inside the window, counting from the oldest that still counts. */
	used: number;
	remaining: number;
	exhausted: boolean;
	/** When the oldest send in the window stops counting — one slot back. */
	nextSlotAt: string | null;
};

/**
 * The allowance from the timestamps of the sends still inside the window.
 *
 * `times` may contain sends older than the window (callers hand over a day's
 * worth of rows); anything at or before the window start is spent and does not
 * count. The boundary is inclusive on the old side: a send that happened exactly
 * 24 hours ago is a fresh slot, because the window is "the last 24 hours", not
 * "the last 24 hours and one millisecond".
 */
export function freeSendState(
	times: readonly number[],
	now: number,
	limit: number = FREE_SENDS_PER_WINDOW,
	windowMs: number = FREE_SEND_WINDOW_MS,
): FreeSendState {
	const start = now - windowMs;
	const inWindow = times.filter((at) => Number.isFinite(at) && at > start && at <= now).sort((a, b) => a - b);
	const used = inWindow.length;
	const remaining = Math.max(0, limit - used);
	return {
		limit,
		used,
		remaining,
		exhausted: remaining === 0,
		// Only a spend frees a slot; an account that has not sent anything waits for
		// nothing.
		nextSlotAt: used >= limit && used > 0 ? new Date(inWindow[0] + windowMs).toISOString() : null,
	};
}
