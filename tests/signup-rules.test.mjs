import assert from "node:assert/strict";
import test from "node:test";

/**
 * Sign-up decides two things before it touches the database: what a username may
 * look like, and what address that username becomes. Both are also used by the
 * form in the browser, so the rules live in one import-free module and are
 * pinned here.
 *
 * The reserved list is not cosmetic. `postmaster`, `abuse` and `dmarc` are
 * addresses mail receivers and people expect the domain itself to own; handing
 * one to a stranger means the domain starts sending mail under a role it cannot
 * answer for.
 */

const rules = await import("../src/lib/auth/signup-rules.ts");
const { checkSignupUsername, checkSignupPassword, checkRecoveryEmail, normalizeSignupUsername, signupAddress } = rules;

test("usernames are folded to lowercase and trimmed", () => {
	assert.equal(normalizeSignupUsername("  Alice  "), "alice");
	assert.equal(normalizeSignupUsername(42), "");
	assert.equal(normalizeSignupUsername(undefined), "");
});

test("a plain username is accepted", () => {
	for (const name of ["alice", "a12", "team-ops", "zhang_san", "x9y"]) {
		const result = checkSignupUsername(name);
		assert.equal(result.ok, true, name);
		if (result.ok) assert.equal(result.username, name);
	}
});

test("the same name in capitals is the same username", () => {
	const result = checkSignupUsername("ALICE");
	assert.equal(result.ok, true);
	assert.equal(result.ok && result.username, "alice");
});

test("rejected shapes name the problem", () => {
	const cases = [
		["", /choose a username/i],
		["ab", /at least/i],
		["a".repeat(31), /at most/i],
		["-alice", /start with a letter or number/i],
		["_alice", /start with a letter or number/i],
		["ali ce", /lowercase letters/i],
		["alice.b", /lowercase letters/i],
		["alice+b", /lowercase letters/i],
		["alice@example.com", /lowercase letters/i],
		["张三丰", /lowercase letters/i],
	];
	for (const [input, pattern] of cases) {
		const result = checkSignupUsername(input);
		assert.equal(result.ok, false, input);
		assert.match(result.ok ? "" : result.error, pattern, input);
	}
});

test("role addresses are reserved", () => {
	for (const name of ["postmaster", "abuse", "dmarc", "noreply", "admin", "root", "hostmaster"]) {
		assert.equal(checkSignupUsername(name).ok, false, name);
	}
	// A reserved word with a suffix is a different address and is fine.
	assert.equal(checkSignupUsername("admin2").ok, true);
	assert.equal(checkSignupUsername("postmaster-general").ok, true);
});

test("the address is the username on the deployment's domain", () => {
	assert.equal(signupAddress("Alice", "Chinapedia.org"), "alice@chinapedia.org");
	assert.equal(signupAddress("bob", " example.com "), "bob@example.com");
});

test("passwords are judged on length only", () => {
	assert.match(checkSignupPassword("short") ?? "", /at least 8/i);
	assert.equal(checkSignupPassword("12345678"), null);
	assert.equal(checkSignupPassword("a".repeat(200)), null);
	assert.match(checkSignupPassword("a".repeat(201)) ?? "", /too long/i);
	assert.match(checkSignupPassword(undefined) ?? "", /at least 8/i);
	// No composition rules: "password" is weak, not malformed. Rejecting it here
	// would only push people toward Password1! and a false sense of safety.
	assert.equal(checkSignupPassword("password"), null);
});

test("the recovery address is optional and must look like an address", () => {
	assert.deepEqual(checkRecoveryEmail(""), { ok: true, email: null });
	assert.deepEqual(checkRecoveryEmail(undefined), { ok: true, email: null });
	assert.deepEqual(checkRecoveryEmail("  me@example.com "), { ok: true, email: "me@example.com" });
	for (const bad of ["me", "me@", "@example.com", "me@example", "a b@example.com"]) {
		assert.equal(checkRecoveryEmail(bad).ok, false, bad);
	}
});
