/**
 * Where a message actually lives, as a list route.
 *
 * A message can be opened from a link that does not name its folder: a push
 * notification, an assistant answer, a bookmark, a URL typed by hand. Those
 * links all point at the Inbox, and a triaged message is not in the Inbox — the
 * reader would show mail the sidebar says is somewhere else, and switching the
 * sidebar to Inbox shows an empty list. The reader therefore sends itself to the
 * list that holds the message, which also moves the sidebar's selection with it.
 *
 * Kept free of imports: the detail page and the tests both use it.
 */

export type FolderRouteMessage = {
	id: string;
	folderId?: string | null;
	status: string;
	direction: string;
	snoozedUntil?: string | null;
};

/**
 * The list route a message is filed in, or null when no list owns it (a queued
 * send, a failed message). Mirrors the counting rules in
 * `src/app/api/messages/counts/utils.ts`: trash, spam and archived win over the
 * folder, and a snoozed message is in Snoozed rather than anywhere else.
 */
export function getMessageFolderPath(message: FolderRouteMessage, now: Date = new Date()): string | null {
	if (message.status === "trash") return "/trash";
	if (message.status === "spam") return "/spam";
	if (message.status === "archived") return "/archived";
	if (message.snoozedUntil && new Date(message.snoozedUntil) > now) return "/snoozed";
	if (message.folderId) return `/folders/${message.folderId}`;
	if (message.direction === "inbound" && message.status === "received") return "/inbox";
	if (message.direction === "outbound" && message.status === "sent") return "/sent";
	return null;
}

/** True when `pathname` already shows a list that contains this message. */
export function isMessageListPath(
	pathname: string | null | undefined,
	message: FolderRouteMessage,
	now: Date = new Date(),
): boolean {
	const path = getMessageFolderPath(message, now);
	if (!path) return true;
	return pathname === path || Boolean(pathname?.startsWith(`${path}/`));
}

/**
 * The path a reader should show for this message, or null when the current
 * path is already right. Starred is a view, not a location: a starred message
 * stays readable from Starred, so opening one there must not jump away.
 */
export function getMessageReaderPath(
	pathname: string | null | undefined,
	message: FolderRouteMessage & { starred?: boolean },
	now: Date = new Date(),
): string | null {
	if (isMessageListPath(pathname, message, now)) return null;
	if (message.starred && pathname?.startsWith("/starred/")) return null;
	const path = getMessageFolderPath(message, now);
	return path ? `${path}/${message.id}` : null;
}
