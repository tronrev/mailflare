import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { checkResendKey } from "@/lib/email/resend-api";
import { readCredentials } from "@/lib/payments/credentials";
import { getSendStatus } from "@/lib/payments/entitlement";
import { sealJson } from "@/lib/payments/secret-box";

/**
 * The account's own provider credentials — the other way to send without paying.
 *
 * Stored sealed (lib/payments/secret-box.ts) and never read back out: the status
 * response carries a description ("Resend, key ending 4f2a"), not the key. Replacing
 * a key is a PUT; removing it is a DELETE, which drops the ciphertext rather than
 * blanking a field.
 */

async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { env, userId: "", error: auth.error };
	if (mutation && !hasValidSessionMutationOrigin(request)) {
		return { env, userId: auth.user.id, error: NextResponse.json({ error: "Invalid origin" }, { status: 403 }) };
	}
	return { env, userId: auth.user.id, error: null };
}

export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return NextResponse.json(await getSendStatus(access.env, { userId: access.userId }), {
		headers: { "Cache-Control": "no-store" },
	});
}

export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const env = access.env;
	const userId = access.userId;

	// Without a sealing secret the key could only be stored in the clear, which is
	// worse than not offering the feature: say so instead of doing it.
	if (!env.BILLING_SECRET?.trim()) {
		return NextResponse.json(
			{ error: "This server cannot store provider keys securely (BILLING_SECRET is not set)." },
			{ status: 503 },
		);
	}

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const check = readCredentials(body?.provider, body);
	if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

	// A Resend key can be checked before it is stored; an SES pair cannot be checked
	// without sending something, so it is stored as given and fails loudly on use.
	if (check.value.provider === "resend") {
		const probe = await checkResendKey(check.value.apiKey).catch(() => null);
		if (!probe) return NextResponse.json({ error: "Could not reach Resend to check this key" }, { status: 502 });
		if (!probe.valid) return NextResponse.json({ error: "Resend rejected this API key" }, { status: 400 });
	}

	const sealed = await sealJson(env.BILLING_SECRET, check.value);
	await getDb(env)
		.update(users)
		.set({ sendProvider: check.value.provider, sendCredentials: sealed, sendCredentialsAt: new Date() })
		.where(eq(users.id, userId));
	return NextResponse.json(await getSendStatus(env, { userId }), { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const env = access.env;
	const userId = access.userId;

	await getDb(env)
		.update(users)
		.set({ sendProvider: null, sendCredentials: null, sendCredentialsAt: null })
		.where(eq(users.id, userId));
	return NextResponse.json(await getSendStatus(env, { userId }), { headers: { "Cache-Control": "no-store" } });
}
