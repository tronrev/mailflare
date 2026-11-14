import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-migration-names-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

const outfile = join(outDir, "names.mjs");
await build({
	entryPoints: [join(root, "src/lib/migrations/names.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "silent",
});

const { matchBundledName } = await import(pathToFileURL(outfile).href);
const bundled = new Set(["0078_add_email_verification.sql", "0079_add_send_entitlements_and_usdt_orders.sql"]);

test("a recorded name resolves to the bundled file for every writer", () => {
	assert.equal(matchBundledName("0078_add_email_verification.sql", bundled), "0078_add_email_verification.sql");
	assert.equal(matchBundledName("0079_add_send_entitlements_and_usdt_orders", bundled), "0079_add_send_entitlements_and_usdt_orders.sql");
	assert.equal(matchBundledName("drizzle/migrations/0078_add_email_verification.sql", bundled), "0078_add_email_verification.sql");
	assert.equal(matchBundledName("drizzle\\migrations\\0079_add_send_entitlements_and_usdt_orders", bundled), "0079_add_send_entitlements_and_usdt_orders.sql");
	assert.equal(matchBundledName("  0078_add_email_verification  ", bundled), "0078_add_email_verification.sql");
});

test("a name from another release stays unknown", () => {
	assert.equal(matchBundledName("0079_remote_content_ask.sql", bundled), undefined);
	assert.equal(matchBundledName("0079_remote_content_ask", bundled), undefined);
	assert.equal(matchBundledName("", bundled), undefined);
	assert.equal(matchBundledName("0083_add_alipay_orders.sql", bundled), undefined);
});
