import type { Translator } from "@/lib/i18n/utils";

/** Local copy so this module stays import-free and testable on its own. */
function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The confirmation mail, in the recipient's language. Same shape as the reset
 * mail: one paragraph saying what was asked for, the link, and the "ignore this
 * if it was not you" line, because an unexpected sign-up is the common case for
 * an address that gets typed into a public form.
 */
export function buildVerificationEmail(
	t: Translator,
	{ email, appName, link, hours }: { email: string; appName: string; link: string; hours: number },
): { subject: string; text: string; html: string } {
	const ignore = t("auth.resetMail.ignore");
	return {
		subject: t("auth.verifyMail.subject", { appName }),
		text: [
			t("auth.verifyMail.intro", { email, appName }),
			"",
			t("auth.verifyMail.instructions", { hours }),
			link,
			"",
			ignore,
		].join("\n"),
		html: `<p>${t("auth.verifyMail.intro", { email: `<b>${escapeHtml(email)}</b>`, appName: escapeHtml(appName) })}</p><p>${escapeHtml(t("auth.verifyMail.instructions", { hours }))}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>${escapeHtml(ignore)}</p>`,
	};
}
