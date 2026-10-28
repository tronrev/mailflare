import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * `POST /api/v1/mail-keys` exists because of a gap between two deliberate rules:
 * admin keys are stripped of every mail scope (`key-auth.ts`), and personal keys
 * can only be created behind a dashboard session (`/api/api-keys`). A deployment
 * that automates its own mailboxes therefore had no way to read verification mail
 * from a script. This route lets an admin key with the `mailboxes` scope issue a
 * **mailbox-scoped personal key**, so the tests below pin the boundaries that
 * keep that safe:
 *
 * 1. it issues `read`/`jmap` only — never `send`, never an admin scope;
 * 2. it cannot name a mailbox outside the admin's own accounts (404);
 * 3. the secret is returned once and stored only as a hash;
 * 4. revoking never touches an admin key.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-mail-keys-route-"));
after(() => {
	rmSync(outDir, { recursive: true, force: true });
	delete globalThis.mailKeysRouteFixture;
});

const mocks = {
	"@/lib/cloudflare": "export function getEnv() { return globalThis.mailKeysRouteFixture.env; }",
	"@/lib/api/admin-auth": "export async function authenticateAdminApiKey() { return globalThis.mailKeysRouteFixture.auth; }",
};

await build({
	entryPoints: {
		route: join(root, "src/app/api/v1/mail-keys/route.ts"),
		apiKeys: join(root, "src/lib/api-keys.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	packages: "external",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
	plugins: [{
		name: "mail-keys-route-fixtures",
		setup(builder) {
			builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server.js", external: true }));
			builder.onResolve({ filter: /^@\/lib\// }, (args) => (args.path in mocks ? { path: args.path, namespace: "mock" } : undefined));
			builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
		},
	}],
});

const { GET, POST, DELETE } = await import(pathToFileURL(join(outDir, "route.mjs")).href);
const { verifyApiKey } = await import(pathToFileURL(join(outDir, "apiKeys.mjs")).href);
const { SqliteDatabase } = await import(pathToFileURL(join(outDir, "database.mjs")).href);
const { applyMigrations } = await import(pathToFileURL(join(outDir, "migrate.mjs")).href);

const ADMIN_AUTH = {
	keyId: "admin-key",
	keyKind: "legacy",
	userId: "owner",
	email: "owner@example.com",
	scopes: ["mailboxes", "domains"],
	mailboxIds: null,
	user: { id: "owner", email: "owner@example.com", role: "admin" },
};

async function fixture(t) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	database.db.exec(`
		INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES
			('owner', 'owner@example.com', 'Owner', 'x', 'admin', 0),
			('other', 'other@example.com', 'Other', 'x', 'admin', 0);
		INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('domain', 'owner', 'example.com', 'zone', 0);
		INSERT INTO mailboxes (id, user_id, domain_id, local_part, type, disabled, created_at) VALUES
			('mine', 'owner', 'domain', 'mine', 'personal', 0, 0),
			('theirs', 'other', 'domain', 'theirs', 'personal', 0, 0);
	`);
	const state = { database, env: { DB: database }, auth: ADMIN_AUTH };
	globalThis.mailKeysRouteFixture = state;
	return state;
}

const post = (body) => POST(new Request("https://mail.example/api/v1/mail-keys", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
}));
const get = (query = "") => GET(new Request(`https://mail.example/api/v1/mail-keys${query}`));
const del = (id) => DELETE(new Request(`https://mail.example/api/v1/mail-keys?id=${encodeURIComponent(id)}`));

function apiKeyRows(database) {
	return database.db.prepare('SELECT id, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled FROM api_keys').all();
}

test("issues a mailbox-scoped read key and returns the secret once", async (t) => {
	const state = await fixture(t);
	const response = await post({ name: "welcome-mailer", mailboxIds: ["mine"] });
	const body = await response.json();
	assert.equal(response.status, 201);
	assert.deepEqual(body.scopes, ["read"], "least privilege: read only");
	assert.deepEqual(body.mailboxIds, ["mine"]);
	assert.deepEqual(body.mailboxes, [{ id: "mine", address: "mine@example.com" }]);
	assert.match(body.key, /^ep_/, "same key format as the dashboard");
	assert.ok(!("keyHash" in body), "the hash never leaves the server");

	const [row] = apiKeyRows(state.database);
	assert.equal(row.user_id, "owner");
	assert.equal(row.name, "welcome-mailer");
	assert.equal(row.scopes, '["read"]');
	assert.equal(row.mailbox_scope_enabled, 1, "the key must stay inside its mailboxes");
	assert.ok(verifyApiKey(body.key, row.key_hash), "the returned secret matches the stored hash");
	assert.notEqual(row.key_hash, body.key, "only the hash is stored");

	const scoped = state.database.db.prepare("SELECT mailbox_id FROM mcp_key_mailboxes WHERE key_id = ?").all(body.id);
	assert.deepEqual(scoped.map((item) => item.mailbox_id), ["mine"]);
});

test("a mailbox owned by another admin cannot be named", async (t) => {
	const state = await fixture(t);
	const response = await post({ mailboxIds: ["theirs"] });
	assert.equal(response.status, 404);
	assert.equal((await response.json()).error, "Mailbox not found");
	assert.equal(apiKeyRows(state.database).length, 0, "no half-created key");

	const mixed = await post({ mailboxIds: ["mine", "theirs"] });
	assert.equal(mixed.status, 404, "one bad mailbox refuses the whole request");
	assert.equal(apiKeyRows(state.database).length, 0);
});

test("send and admin scopes are refused outright", async (t) => {
	await fixture(t);
	for (const scopes of [["send"], ["read", "domains"], ["*"]]) {
		const response = await post({ mailboxIds: ["mine"], scopes });
		assert.equal(response.status, 400, `scopes ${JSON.stringify(scopes)} must not be issuable`);
	}
});

test("requests without an admin key are unauthorized", async (t) => {
	const state = await fixture(t);
	state.auth = null;
	assert.equal((await post({ mailboxIds: ["mine"] })).status, 401);
	assert.equal((await get()).status, 401);
	assert.equal((await del("anything")).status, 401);
});

test("listing shows mail keys only, with their mailboxes", async (t) => {
	const state = await fixture(t);
	await post({ mailboxIds: ["mine"], name: "reader" });
	state.database.db.exec(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
		VALUES ('admin-key', 'legacy', 'owner', 'admin', 'ep_adminpref', 'hash', '["domains","mailboxes"]', 0, 0);`);

	const body = await (await get()).json();
	assert.equal(body.mailKeys.length, 1, "the admin key stays out of the mail key list");
	assert.equal(body.mailKeys[0].name, "reader");
	assert.deepEqual(body.mailKeys[0].scopes, ["read"]);
	assert.deepEqual(body.mailKeys[0].mailboxIds, ["mine"]);
});

test("revoking a mail key works, revoking an admin key does not", async (t) => {
	const state = await fixture(t);
	const created = await (await post({ mailboxIds: ["mine"] })).json();
	state.database.db.exec(`INSERT INTO api_keys (id, kind, user_id, name, prefix, key_hash, scopes, mailbox_scope_enabled, created_at)
		VALUES ('admin-key', 'legacy', 'owner', 'admin', 'ep_adminpref', 'hash', '["domains"]', 0, 0);`);

	const adminDelete = await del("admin-key");
	assert.equal(adminDelete.status, 403, "this route must never revoke an admin key");
	assert.equal(apiKeyRows(state.database).length, 2);

	const ok = await del(created.id);
	assert.equal(ok.status, 200);
	assert.equal(apiKeyRows(state.database).length, 1);
	assert.equal(state.database.db.prepare("SELECT count(*) AS n FROM mcp_key_mailboxes").get().n, 0, "mailbox rows cascade");
});
