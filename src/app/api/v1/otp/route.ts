import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNotNull, lte, type SQL } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { getDb } from "@/db";
import { messageTriage, messages, users } from "@/db/schema";
import { listAccessibleMailboxIds } from "@/lib/mailboxes/access";

/**
 * The passcodes triage read out of incoming mail, for anything that can hold an
 * API key: a script that fills a login form, a browser extension, an MCP client.
 *
 * The code is returned in clear — it is the point of the endpoint — so the key
 * has to be one the user issued to themselves, and the window defaults to the
 * last day rather than the whole archive.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateApiKey(env, request.headers.get("authorization"));
	if (!auth || !requireScope(auth.scopes, "read")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const db = getDb(env);
	const [user] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
	if (!user || user.disabled) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const now = new Date();
	const since = parseInstant(url.searchParams.get("since")) ?? new Date(now.getTime() - 86_400_000);
	const until = parseInstant(url.searchParams.get("until")) ?? now;
	const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 100);
	const activeOnly = url.searchParams.get("active") === "1";

	const conditions: SQL[] = [
		eq(messageTriage.userId, auth.userId),
		eq(messageTriage.category, "otp"),
		gte(messageTriage.createdAt, since),
		lte(messageTriage.createdAt, until),
	];
	// A key can be narrowed to a set of mailboxes; respect that here too, or it
	// would read codes from mail it is not allowed to see.
	if (auth.mailboxIds?.length) {
		conditions.push(inArray(messageTriage.mailboxId, auth.mailboxIds));
	} else {
		const accessible = await listAccessibleMailboxIds(db, user);
		if (accessible.length === 0) return NextResponse.json({ otp: [] });
		conditions.push(inArray(messageTriage.mailboxId, accessible));
	}
	if (activeOnly) conditions.push(isNotNull(messageTriage.otpExpiresAt));

	const rows = await db
		.select({
			messageId: messageTriage.messageId,
			mailboxId: messageTriage.mailboxId,
			provider: messageTriage.otpProvider,
			code: messageTriage.otpCode,
			expiresAt: messageTriage.otpExpiresAt,
			receivedAt: messageTriage.createdAt,
			subject: messages.subject,
			from: messages.fromAddr,
		})
		.from(messageTriage)
		.innerJoin(messages, eq(messages.id, messageTriage.messageId))
		.where(and(...conditions))
		.orderBy(desc(messageTriage.createdAt))
		.limit(limit);

	const otp = rows
		.map((row) => ({
			messageId: row.messageId,
			mailboxId: row.mailboxId,
			provider: row.provider,
			code: row.code,
			expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
			expired: row.expiresAt ? row.expiresAt.getTime() <= now.getTime() : false,
			subject: row.subject,
			from: row.from,
			receivedAt: row.receivedAt.toISOString(),
		}))
		.filter((row) => !activeOnly || !row.expired);

	return NextResponse.json({ otp }, { headers: { "Cache-Control": "no-store" } });
}

function parseInstant(raw: string | null): Date | null {
	if (!raw) return null;
	const asNumber = Number(raw);
	const value = Number.isFinite(asNumber) && raw.trim() !== "" ? new Date(asNumber) : new Date(raw);
	return Number.isNaN(value.getTime()) ? null : value;
}
