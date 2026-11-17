import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-send-failure-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: [join(root, "src/app/api/send/error-utils.ts")],
	outfile: join(outDir, "error-utils.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { describeSendFailure } = await import(pathToFileURL(join(outDir, "error-utils.mjs")).href);

/** What drizzle throws: the query and its parameters, with the reason on `cause`. */
function queryFailure(reason) {
	const cause = new Error(reason);
	cause.name = "D1_ERROR";
	const error = new Error(
		'Failed query: insert into "messages" ("id", "from_addr", "subject") values (?, ?, ?)\nparams: msg_1,"liruqi" <liruqi@example.org>,hiiiii',
	);
	error.cause = cause;
	return error;
}

test("a missing column reports a pending migration, not the SQL", () => {
	const failure = describeSendFailure(queryFailure("table messages has no column named invite_response"));
	assert.equal(failure.status, 409);
	assert.equal(failure.code, "MIGRATION_REQUIRED");
	assert.match(failure.message, /migration pending/i);
	// The composer must not show the statement or the message body.
	assert.doesNotMatch(failure.message, /insert into|params:/i);
});

test("a missing table reports the same pending migration", () => {
	const failure = describeSendFailure(queryFailure("no such table: messages"));
	assert.equal(failure.code, "MIGRATION_REQUIRED");
	assert.equal(failure.status, 409);
});

test("any other driver failure carries the driver's own words", () => {
	const failure = describeSendFailure(queryFailure("FOREIGN KEY constraint failed"));
	assert.equal(failure.message, "FOREIGN KEY constraint failed");
	assert.equal(failure.status, 500);
	assert.doesNotMatch(failure.message, /Failed query|params:/);
});

test("sending refusals keep their status and their sentence", () => {
	const quota = describeSendFailure(new Error("Sending is not enabled for this address. Add your own Resend or Amazon SES key, or buy sending time, in Settings → Sending."));
	assert.equal(quota.status, 402);
	assert.match(quota.message, /Sending is not enabled/);

	assert.equal(describeSendFailure(new Error("Mailbox is required")).status, 400);
	assert.equal(describeSendFailure(new Error("You do not have permission to send from this mailbox")).status, 403);
});

test("something that is not an error still answers in words", () => {
	assert.deepEqual(describeSendFailure("boom"), { message: "Send failed", status: 500 });
});
