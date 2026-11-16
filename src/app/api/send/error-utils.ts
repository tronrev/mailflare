import { describeDatabaseError, isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
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

/** How a failed send is answered, and what the composer shows. */
export type SendFailure = {
	message: string;
	status: number;
	code?: "MIGRATION_REQUIRED";
};

const MIGRATION_REQUIRED_MESSAGE =
	"This deployment has a database migration pending, so the message could not be saved. Apply the pending migrations from the admin settings, then send it again.";

/**
 * The failure to report for a send that threw.
 *
 * Drizzle reports every failed query as "Failed query: insert into `messages` …
 * params: …", which says the insert failed and nothing about why — and puts the
 * SQL, along with the subject and body, in front of whoever pressed Send. The
 * driver's own reason lives on `cause`, so that is what the response carries. A
 * missing table or column is the one failure whose fix the person reading it can
 * apply, so it gets its own status and sentence instead of a bare 500.
 */
export function describeSendFailure(error: unknown): SendFailure {
	if (isMissingTableError(error) || isMissingColumnError(error)) {
		return { message: MIGRATION_REQUIRED_MESSAGE, status: 409, code: "MIGRATION_REQUIRED" };
	}
	if (!(error instanceof Error)) return { message: "Send failed", status: 500 };
	const message = describeDatabaseError(error);
	return { message, status: getSendErrorStatus(message) };
}
