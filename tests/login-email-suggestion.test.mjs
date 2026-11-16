import assert from "node:assert/strict";
import test from "node:test";
import { preferredDomain, suggestEmailCompletion } from "../src/lib/auth/login-email-suggestion.ts";

const domains = ["qimago.com", "mail.qimago.com", "example.org"];
const hostname = "mail.qimago.com";

const suggest = (value, extra = {}) =>
	suggestEmailCompletion(value, { domains, hostname, ...extra });

test("nothing is offered before three characters", () => {
	assert.equal(suggest(""), null);
	assert.equal(suggest("r"), null);
	assert.equal(suggest("ro"), null);
});

test("three characters are enough to offer the domain", () => {
	assert.deepEqual(suggest("root"), { value: "root@qimago.com", suffix: "@qimago.com" });
});

test("the parent of a mail. hostname wins over the hostname itself", () => {
	// The form lives on mail.qimago.com, the addresses live on qimago.com.
	assert.equal(preferredDomain(domains, hostname), "qimago.com");
	assert.equal(preferredDomain(["mail.qimago.com"], hostname), "mail.qimago.com");
});

test("without a matching hostname the first configured domain is used", () => {
	assert.equal(preferredDomain(domains, "mail.elsewhere.test"), "qimago.com");
	assert.equal(preferredDomain([], hostname), null);
});

test("the port on the host header does not matter", () => {
	assert.equal(preferredDomain(domains, "mail.qimago.com:3000"), "qimago.com");
	assert.equal(preferredDomain(domains, "localhost:3000"), "qimago.com");
});

test("typing @ triggers the suggestion on its own", () => {
	assert.deepEqual(suggest("root@"), { value: "root@qimago.com", suffix: "qimago.com" });
});

test("after @ the typed prefix picks the domain", () => {
	assert.deepEqual(suggest("root@exa"), { value: "root@example.org", suffix: "mple.org" });
	// Two domains start with "mail.", so the preferred one is filled in.
	assert.deepEqual(suggest("root@mail"), { value: "root@mail.qimago.com", suffix: ".qimago.com" });
	assert.equal(suggest("root@exa").suffix, "mple.org");
});

test("a prefix no domain matches is left alone", () => {
	assert.equal(suggest("root@gmail"), null);
	assert.equal(suggest("root@qimago.com"), null);
});

test("an address already on a configured domain needs no completion", () => {
	assert.equal(suggest("root@example.org"), null);
	// Case-insensitive: the suffix would only repeat what is typed.
	assert.equal(suggest("root@EXAMPLE.ORG"), null);
});

test("whitespace and repeated @ are not completed", () => {
	assert.equal(suggest("root smith"), null);
	assert.equal(suggest("root@exa mple"), null);
	assert.equal(suggest("root@exa@mple"), null);
});

test("a local part of case and dots keeps what the user typed", () => {
	assert.deepEqual(suggest("Root.Smith"), { value: "Root.Smith@qimago.com", suffix: "@qimago.com" });
});
