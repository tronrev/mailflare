import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { recordAuthActivity } from "@/lib/auth/activity";
import { allowSignupAttempt } from "@/lib/auth/rate-limit";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getServerTranslator } from "@/lib/i18n/server";
import { createSignupAccount } from "@/lib/auth/signup";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";

/**
 * Self-service sign-up: a visitor creates a personal account on the deployment's
 * own domain. Distinct from `POST /api/auth/register`, which exists once, before
 * the first account, and also creates the domain itself.
 *
 * The account is signed in on success — the person just proved who they are by
 * choosing a password, and sending them to a login form would ask for it twice.
 */
export async function POST(request: Request) {
	const env = getEnv();

	// Nothing to join before the first admin exists; that is `/setup`'s job.
	if (!(await hasAdminAccount(env))) {
		return NextResponse.json(
			{ error: "This server has not finished setup yet.", redirect: "/setup" },
			{ status: 409 },
		);
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid sign-up request" }, { status });
	}

	if (!(await allowSignupAttempt(env, request))) {
		return NextResponse.json(
			{ error: "Too many sign-up attempts. Try again shortly." },
			{ status: 429, headers: { "Retry-After": "60" } },
		);
	}
	const payload = (body ?? {}) as Record<string, unknown>;
	if (!(await verifyTurnstileToken(env, request, payload.turnstileToken))) {
		return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
	}

	const outcome = await createSignupAccount(env, {
		username: payload.username,
		password: payload.password,
		recoveryEmail: payload.recoveryEmail,
		origin: new URL(request.url).origin,
		t: await getServerTranslator(),
	});
	if (!outcome.ok) {
		return NextResponse.json({ error: outcome.error }, { status: outcome.status });
	}

	await recordAuthActivity(env, { action: "auth.signup", userId: outcome.userId, request });

	// No session yet. The address is a claim until the link in its inbox is
	// opened, and a cookie handed out now would make the claim look proven.
	const response = NextResponse.json({
		ok: true,
		pendingVerification: true,
		redirect: "/verify-email?sent=1",
		email: outcome.email,
		sentTo: outcome.verificationSentTo,
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
}
