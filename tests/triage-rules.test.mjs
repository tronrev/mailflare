import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-triage-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { rules: join(root, "src/lib/triage/rules.ts") },
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
});

const {
	extractOtpCode,
	extractVerificationLink,
	guessProvider,
	heuristicTriageCategory,
	looksLikeOtp,
	looksLikeVerify,
	normalizeTriageCategory,
	parseOtpLifetimeMinutes,
	parseVerifyLifetimeMinutes,
	registrableDomain,
	splitSender,
	triageFolderFor,
	triageRetentionUntil,
} = await import(pathToFileURL(join(outDir, "rules.mjs")).href);

const MINUTE = 60_000;

test("a code next to the word for it is the code", () => {
	assert.equal(extractOtpCode({ subject: "Your verification code", text: "Your verification code is 482913. It expires in 10 minutes." }), "482913");
	assert.equal(extractOtpCode({ subject: "【GitHub】验证码", text: "您的验证码为 582913，10 分钟内有效。" }), "582913");
});

test("the code in the subject wins over numbers in the body", () => {
	const code = extractOtpCode({
		subject: "731204 is your OpenAI code",
		text: "Order 998812 was placed for ¥120.00. Call 400-820-8820 for help.",
	});
	assert.equal(code, "731204");
});

test("amounts and order numbers are not codes", () => {
	assert.equal(extractOtpCode({ subject: "Your receipt", text: "Total ¥1,234.00, invoice 20260115" }), null);
	assert.equal(looksLikeOtp("Your order shipped", "Tracking number 123456"), false);
});

test("how long the code lasts is read from either language", () => {
	assert.equal(parseOtpLifetimeMinutes("10 分钟内有效"), 10);
	assert.equal(parseOtpLifetimeMinutes("This code expires in 15 minutes."), 15);
	assert.equal(parseOtpLifetimeMinutes("Valid for 1 hour"), 60);
	assert.equal(parseOtpLifetimeMinutes("nothing here"), null);
	// Clamped: a mail that says "3 minutes" still gets the floor, because clocks drift.
	assert.equal(parseOtpLifetimeMinutes("expires in 3 minutes"), 5);
});

test("retention follows the category", () => {
	const received = new Date("2026-11-05T10:00:00Z");
	// A confirmation link is kept until it stops working, a week by default.
	assert.equal(triageRetentionUntil("verify", received).getTime(), received.getTime() + 7 * 86_400_000);
	assert.equal(triageRetentionUntil("verify", received, 30).getTime(), received.getTime() + 30 * MINUTE);
	assert.equal(parseVerifyLifetimeMinutes("This link expires in 48 hours."), 48 * 60);
	assert.equal(triageRetentionUntil("important", received), null);
	assert.equal(triageRetentionUntil("other", received), null);
	assert.equal(triageRetentionUntil("promo", received).getTime(), received.getTime() + 30 * 86_400_000);
	assert.equal(triageRetentionUntil("social", received).getTime(), received.getTime() + 90 * 86_400_000);
	const otp = triageRetentionUntil("otp", received, 7);
	assert.equal(otp.getTime(), received.getTime() + 7 * MINUTE);
	assert.equal(triageRetentionUntil("otp", received).getTime(), received.getTime() + 10 * MINUTE);
});

test("sign-up confirmations get a folder too", () => {
	assert.equal(triageFolderFor("verify").name, "Verify");
	assert.equal(triageFolderFor("otp").name, "OTP");
	assert.equal(triageFolderFor("promo").name, "Promotions");
	assert.equal(triageFolderFor("important"), null);
	assert.equal(triageFolderFor("other"), null);
});

test("sender display name beats a generic one", () => {
	assert.deepEqual(splitSender("GitHub <noreply@github.com>"), { displayName: "GitHub", address: "noreply@github.com" });
	assert.equal(guessProvider("GitHub <noreply@github.com>", "GitHub"), "GitHub");
	assert.equal(guessProvider("noreply@github.com", "no-reply"), "Github");
	assert.equal(guessProvider("noreply@accounts.steamcommunity.com"), "Steamcommunity");
});

test("model answers are normalized, garbage falls back", () => {
	assert.equal(normalizeTriageCategory(" Promotional "), "promo");
	assert.equal(normalizeTriageCategory("one-time passcode"), "otp");
	assert.equal(normalizeTriageCategory("banana"), "other");
	assert.equal(normalizeTriageCategory(null), "other");
});

test("the heuristic fallback reads the obvious cases", () => {
	assert.equal(heuristicTriageCategory("50% off this week", "Unsubscribe any time", "shop@store.com"), "promo");
	assert.equal(heuristicTriageCategory("Your order has shipped", "Tracking number 1Z999", "ship@shop.com"), "updates");
	assert.equal(heuristicTriageCategory("面试安排 - 后端工程师", "请确认周三下午的时间", "hr@company.com"), "important");
	assert.equal(heuristicTriageCategory("LinkedIn", "You have a new follower", "notifications@linkedin.com"), "social");
	assert.equal(heuristicTriageCategory("Lunch?", "See you at noon", "friend@example.com"), "other");
});

test("confirmation mail is recognised by its wording, passcode mail is not", () => {
	assert.equal(looksLikeVerify("请验证您的邮箱", "点击下面的按钮完成验证"), true);
	assert.equal(looksLikeVerify("Please confirm your email address", "Confirm now"), true);
	assert.equal(looksLikeVerify("Verify your account", "Your verification code is 482913"), false);
	assert.equal(looksLikeVerify("Your order has shipped", "Tracking number 1Z999"), false);
	// The order of the words must not matter in Chinese.
	assert.equal(looksLikeVerify("您的邮箱尚未验证", ""), true);
	assert.equal(looksLikeVerify("验证码已发送至您的邮箱", ""), false);
});

test("the confirmation link beats the logo, the footer and the unsubscribe line", () => {
	const html = [
		'<a href="https://www.trip.com/"><img src="https://cdn.trip.com/logo.png"></a>',
		'<a href="https://www.trip.com/unsubscribe?u=9f2a1c">Unsubscribe</a>',
		'<a href="https://www.trip.com/privacy">Privacy policy</a>',
		'<a href="https://account.trip.com/email/verify?token=8f2c41ab9d7e4c0e8b31">Verify email</a>',
	].join("");
	const link = extractVerificationLink({ subject: "请验证您的邮箱", html, fromAddr: "Trip.com <noreply@trip.com>" });
	assert.equal(link, "https://account.trip.com/email/verify?token=8f2c41ab9d7e4c0e8b31");
});

test("a tracking domain still counts when the button says verify", () => {
	const html = '<a href="https://click.mailflare.net/ls/click?upn=abc123def456ghi789">Confirm your email address</a>';
	const link = extractVerificationLink({
		subject: "Confirm your email address",
		html,
		fromAddr: "Mailflare <noreply@mailflare.net>",
	});
	assert.equal(link, "https://click.mailflare.net/ls/click?upn=abc123def456ghi789");
});

test("a plain-text link is found next to the words that introduce it", () => {
	const text = ["Welcome aboard.", "To finish signing up, open this link:", "https://app.example.com/confirm/9f8e7d6c5b4a3210", "", "Thanks!"].join("\n");
	const link = extractVerificationLink({ subject: "Complete your registration", text, fromAddr: "Example <hello@example.com>" });
	assert.equal(link, "https://app.example.com/confirm/9f8e7d6c5b4a3210");
});

test("ordinary mail has no confirmation link", () => {
	const html = '<p>Thanks for your order.</p><a href="https://shop.example.com/orders/1234">View order</a>';
	assert.equal(extractVerificationLink({ subject: "Your order", html, fromAddr: "Shop <shop@example.com>" }), null);
	assert.equal(extractVerificationLink({ subject: "Hello", text: "See you at noon.", fromAddr: "friend@example.com" }), null);
});

test("a sender domain is the part a company owns", () => {
	assert.equal(registrableDomain("mailer.trip.com"), "trip.com");
	assert.equal(registrableDomain("accounts.steamcommunity.com"), "steamcommunity.com");
	assert.equal(registrableDomain("a.b.example.co.uk"), "example.co.uk");
	assert.equal(registrableDomain(""), null);
});
