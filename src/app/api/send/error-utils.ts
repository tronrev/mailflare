import { SEND_QUOTA_MESSAGE } from "@/lib/payments/free-send-rules";

/**
 * 402 means "this account is out of sending": either it never qualified, or it
 * has spent the free allowance. Both are answered with the same two ways out
 * (bring a provider key, or buy time), so the composer can put those in front of
 * the person instead of a toast that only repeats the server's sentence.
 */
export function getSendErrorStatus(message: string): number {
	if (message === "Mailbox is required") return 400;
	if (message.startsWith("Attachments exceed") || message.startsWith("Subject exceeds") || message.startsWith("Headers exceed") || message.startsWith("Message exceeds Cloudflare") || message.startsWith("A message can include at most") || message.includes("exceeds the 25 MB attachment limit")) return 400;
	if (
		message === "Mailbox not found" ||
		message === "Sender account not found" ||
		message === "You do not have permission to send from this mailbox" ||
		message === "Sender address does not match the selected mailbox"
	) {
		return 403;
	}
	if (message === SEND_QUOTA_MESSAGE || message.startsWith("Sending is not enabled for this address")) return 402;
	return 500;
}
