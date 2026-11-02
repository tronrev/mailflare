/**
 * Whether opening the composer should be met with "sending is not switched on".
 *
 * The composer is the place people notice: a mailbox that receives perfectly well
 * still refuses to send until the account qualifies, and the refusal used to
 * surface only after a message was written and sent. This decides, from the same
 * status the settings page draws, whether to show the two ways out instead of an
 * empty letter.
 *
 * Kept free of imports so the rule can be tested on its own.
 */

export type SendAccessView = {
	/** Sending works right now (the domain sends, credentials are stored, or time is paid). */
	allowed: boolean;
	/** An administrator: they own the settings that decide this, so nothing is sold to them. */
	admin?: boolean;
};

/**
 * `false` while the answer is still unknown: a slow or failed status request must
 * not stop somebody who can send, and the send endpoint refuses on its own anyway.
 */
export function needsSendGuide(view: SendAccessView | null | undefined): boolean {
	if (!view) return false;
	return !view.allowed && !view.admin;
}
