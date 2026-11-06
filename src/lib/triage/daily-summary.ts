import { and, desc, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes, messageTriage, messages, users } from "@/db/schema";
import { sendSystemEmail } from "@/lib/email/system-mail";
import { CATEGORY_RETENTION_DAYS, type TriageCategory } from "./rules";

/** Users handled per tick; each one costs a handful of tiny queries. */
const SUMMARY_BATCH = 100;
const HIGHLIGHT_LIMIT = 6;

export type LocalClock = { date: string; hour: number };

/**
 * The date and hour at the user's own clock. Falls back to UTC for a null or
 * unusable zone: a summary an hour off is better than a cron that throws.
 */
export function localClock(now: Date, timeZone: string | null | undefined): LocalClock {
	try {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: timeZone || "UTC",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hour12: false,
		}).formatToParts(now);
		const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
		const hour = Number(get("hour")) % 24;
		return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.isFinite(hour) ? hour : 0 };
	} catch {
		return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours() };
	}
}

/**
 * Posts one summary a day, at the user's midnight, to the recovery address.
 *
 * Runs from the five-minute cron, so the "midnight hour" is seen several times:
 * `users.daily_summary_on` records the local date that was already summarised
 * and makes the rest of the hour a no-op.
 */
export async function runDailySummaries(env: CloudflareEnv, now = new Date()): Promise<number> {
	const db = getDb(env);
	const recipients = await db
		.select({
			id: users.id,
			recoveryEmail: users.resetEmail,
			timeZone: users.timeZone,
			sentOn: users.dailySummaryOn,
		})
		.from(users)
		.where(and(isNull(users.deletedAt), eq(users.disabled, false), isNotNull(users.resetEmail)))
		.limit(SUMMARY_BATCH);

	let sent = 0;
	for (const user of recipients) {
		const clock = localClock(now, user.timeZone);
		if (clock.hour !== 0 || clock.date === user.sentOn) continue;
		try {
			const delivered = await summariseOne(env, user.id, user.recoveryEmail as string, now);
			// Mark the day either way: a mailbox with nothing new does not need a
			// second look at 00:05, 00:10 and 00:15.
			await db.update(users).set({ dailySummaryOn: clock.date }).where(eq(users.id, user.id));
			if (delivered) sent += 1;
		} catch (error) {
			console.error("[triage] daily summary failed:", error instanceof Error ? error.message : String(error));
		}
	}
	return sent;
}

async function summariseOne(env: CloudflareEnv, userId: string, recoveryEmail: string, now: Date): Promise<boolean> {
	const db = getDb(env);
	const since = new Date(now.getTime() - 86_400_000);

	const [{ total }] = await db
		.select({ total: sql<number>`count(*)` })
		.from(messages)
		.where(and(
			eq(messages.userId, userId),
			eq(messages.direction, "inbound"),
			notInArray(messages.status, ["spam", "trash"]),
			gte(messages.createdAt, since),
			lte(messages.createdAt, now),
		));
	if (!total) return false;

	const byCategory = await db
		.select({ category: messageTriage.category, count: sql<number>`count(*)` })
		.from(messageTriage)
		.where(and(eq(messageTriage.userId, userId), gte(messageTriage.createdAt, since), lte(messageTriage.createdAt, now)))
		.groupBy(messageTriage.category);

	const highlights = await db
		.select({
			category: messageTriage.category,
			subject: messages.subject,
			fromAddr: messages.fromAddr,
		})
		.from(messageTriage)
		.innerJoin(messages, eq(messages.id, messageTriage.messageId))
		.where(and(
			eq(messageTriage.userId, userId),
			gte(messageTriage.createdAt, since),
			inArray(messageTriage.category, ["important", "other"]),
		))
		.orderBy(desc(messageTriage.createdAt))
		.limit(HIGHLIGHT_LIMIT);

	const otpProviders = await db
		.select({ provider: messageTriage.otpProvider, count: sql<number>`count(*)` })
		.from(messageTriage)
		.where(and(eq(messageTriage.userId, userId), eq(messageTriage.category, "otp"), gte(messageTriage.createdAt, since)))
		.groupBy(messageTriage.otpProvider);

	const counts = new Map(byCategory.map((row) => [row.category as TriageCategory, Number(row.count)]));
	const labelled: Array<[string, number]> = [
		["OTP", counts.get("otp") ?? 0],
		["Verify", counts.get("verify") ?? 0],
		["Promotions", counts.get("promo") ?? 0],
		["Social", counts.get("social") ?? 0],
		["Updates", counts.get("updates") ?? 0],
		["Important", counts.get("important") ?? 0],
		["Other", counts.get("other") ?? 0],
	];

	const [mailbox] = await db
		.select({ hostname: domains.hostname, localPart: mailboxes.localPart })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.userId, userId))
		.limit(1);

	const lines = [
		`You received ${total} new message${Number(total) === 1 ? "" : "s"} in the last 24 hours.`,
		"",
		...labelled.filter(([, count]) => count > 0).map(([label, count]) => `  ${label.padEnd(12)} ${count}`),
	];
	const providerList = otpProviders.filter((row) => row.provider).map((row) => `${row.provider} (${row.count})`);
	if (providerList.length) lines.push("", `Codes came from: ${providerList.join(", ")}`);
	if (highlights.length) {
		lines.push("", "Worth opening:");
		for (const item of highlights) {
			lines.push(`  - ${item.subject ?? "(no subject)"} — ${item.fromAddr}`);
		}
	}
	lines.push(
		"",
		"Passcodes are deleted once they stop working, confirmation links once they expire; promotions after " +
			`${CATEGORY_RETENTION_DAYS.promo} days, social and status mail after ${CATEGORY_RETENTION_DAYS.social} days. ` +
			"Anything a person wrote to you is kept.",
	);

	const text = lines.join("\n");
	const html = [
		`<p>You received <strong>${total}</strong> new message${Number(total) === 1 ? "" : "s"} in the last 24 hours.</p>`,
		"<ul>",
		...labelled.filter(([, count]) => count > 0).map(([label, count]) => `<li>${label}: ${count}</li>`),
		"</ul>",
		providerList.length ? `<p>Codes came from: ${providerList.join(", ")}</p>` : "",
		highlights.length
			? `<p>Worth opening:</p><ul>${highlights.map((item) => `<li>${escapeHtml(item.subject ?? "(no subject)")} — ${escapeHtml(item.fromAddr)}</li>`).join("")}</ul>`
			: "",
	].join("");

	return sendSystemEmail(env, {
		to: recoveryEmail,
		subject: mailbox ? `Your mail on ${mailbox.hostname} yesterday (${total} new)` : `Your mail yesterday (${total} new)`,
		text,
		html,
		hostname: mailbox?.hostname,
	});
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
