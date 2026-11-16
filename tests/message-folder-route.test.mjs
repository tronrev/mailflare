import assert from "node:assert/strict";
import test from "node:test";
import {
	getMessageFolderPath,
	getMessageReaderPath,
	isMessageListPath,
} from "../src/lib/messages/folder-route.ts";

const inboxMessage = { id: "m1", status: "received", direction: "inbound", folderId: null };

test("a triaged message belongs to its folder, not the Inbox", () => {
	const triaged = { ...inboxMessage, folderId: "fld_otp" };
	assert.equal(getMessageFolderPath(triaged), "/folders/fld_otp");
	// The notification link says /inbox; the reader follows the message instead.
	assert.equal(getMessageReaderPath("/inbox/m1", triaged), "/folders/fld_otp/m1");
});

test("an untriaged inbound message stays in the Inbox", () => {
	assert.equal(getMessageFolderPath(inboxMessage), "/inbox");
	assert.equal(getMessageReaderPath("/inbox/m1", inboxMessage), null);
});

test("trash, spam and archived win over the folder the message was filed in", () => {
	const filed = { ...inboxMessage, folderId: "fld_otp" };
	assert.equal(getMessageFolderPath({ ...filed, status: "trash" }), "/trash");
	assert.equal(getMessageFolderPath({ ...filed, status: "spam" }), "/spam");
	assert.equal(getMessageFolderPath({ ...filed, status: "archived" }), "/archived");
	// Deleting the open message moves the reader with it.
	assert.equal(getMessageReaderPath("/folders/fld_otp/m1", { ...filed, status: "trash" }), "/trash/m1");
});

test("sent mail opens in Sent", () => {
	const sent = { id: "m3", status: "sent", direction: "outbound" };
	assert.equal(getMessageFolderPath(sent), "/sent");
	assert.equal(getMessageReaderPath("/inbox/m3", sent), "/sent/m3");
});

test("a snoozed message is in Snoozed until it wakes up", () => {
	const now = new Date("2026-11-16T00:00:00Z");
	const snoozed = { ...inboxMessage, snoozedUntil: "2026-11-17T00:00:00Z" };
	assert.equal(getMessageFolderPath(snoozed, now), "/snoozed");
	assert.equal(getMessageFolderPath({ ...snoozed, snoozedUntil: "2026-11-15T00:00:00Z" }, now), "/inbox");
});

test("Starred is a view, not a location", () => {
	const starred = { ...inboxMessage, starred: true };
	// Starred holds the message, so the reader stays where the person clicked.
	assert.equal(getMessageReaderPath("/starred/m1", starred), null);
	// Anywhere else, the message is still filed in Inbox.
	assert.equal(getMessageReaderPath("/inbox/m1", { ...starred, folderId: "fld_otp" }), "/folders/fld_otp/m1");
});

test("no list owns a queued or failed send", () => {
	const queued = { id: "m4", status: "queued", direction: "outbound" };
	assert.equal(getMessageFolderPath(queued), null);
	assert.equal(getMessageReaderPath("/inbox/m4", queued), null);
});

test("a reader already on the owning list is left alone", () => {
	const triaged = { ...inboxMessage, folderId: "fld_otp" };
	assert.equal(isMessageListPath("/folders/fld_otp/m1", triaged), true);
	assert.equal(getMessageReaderPath("/folders/fld_otp/m1", triaged), null);
	assert.equal(isMessageListPath("/folders/fld_otpX/m1", triaged), false);
	assert.equal(isMessageListPath("/inbox", inboxMessage), true);
	assert.equal(isMessageListPath("/spam/m1", inboxMessage), false);
});
