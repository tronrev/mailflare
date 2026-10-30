import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { ACCOUNTS_COOKIE, rememberLogin } from "@/lib/auth/accounts";
import { recordAuthActivity } from "@/lib/auth/activity";
import { allowVerificationMailAttempt } from "@/lib/auth/rate-limit";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { consumeEmailVerification, resendEmailVerification } from "@/lib/auth/verify-email";
import { getServerTranslator } from "@/lib/i18n/server";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * The link in the confirmation mail lands here. Opening it is the proof: it was
 * mailed to an address this person controls, so the account is confirmed and
 * signed in at the same time — asking for the password again immediately after
 * would be a second lock on a door just walked through.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const url = new URL(request.url);
	const outcome = await consumeEmailVerification(env, url.searchParams.get("token") ?? "");
	if (!outcome.ok) {
		return NextResponse.redirect(new URL("/verify-email?state=invalid", url.origin), 303);
	}

	const token = await createSession(env, outcome.userId);
	await recordAuthActivity(env, { action: "auth.login", userId: outcome.userId, request });

	const response = NextResponse.redirect(new URL("/inbox", url.origin), 303);
	response.headers.set("Cache-Control", "no-store");
	response.cookies.set(SESSION_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: SESSION_MAX_AGE,
	});
	const accountsJar = await cookies();
	await rememberLogin(env, response, accountsJar.get(ACCOUNTS_COOKIE)?.value, token, accountsJar.get(SESSION_COOKIE)?.value);
	return response;
}

/**
 * Sends another link. Always answers the same, whether the address is unknown,
 * already confirmed or merely unread: the reply must not become a way to find
 * out which addresses have accounts here.
 */
export async function POST(request: Request) {
	const env = getEnv();
	let body: unknown;
	try {
		body = await readJsonBody(request, 4 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid request" }, { status });
	}
	const email = typeof (body as Record<string, unknown>)?.email === "string" ? String((body as Record<string, unknown>).email) : "";

	if (!(await allowVerificationMailAttempt(env, request))) {
		return NextResponse.json(
			{ error: "Too many attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	}

	await resendEmailVerification(env, email, new URL(request.url).origin, await getServerTranslator()).catch((error) => {
		console.warn("Could not send another confirmation link", error);
	});

	const response = NextResponse.json({ ok: true });
	response.headers.set("Cache-Control", "no-store");
	return response;
}
