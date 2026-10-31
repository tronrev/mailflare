export type SignupResponse = {
	ok?: boolean;
	redirect?: string;
	email?: string;
	sentTo?: string;
	pendingVerification?: boolean;
	error?: string;
};

export type SignupPayload = {
	username: string;
	password: string;
	recoveryEmail: string;
	turnstileToken?: string;
};

export async function submitSignup(payload: SignupPayload): Promise<{ ok: boolean; data: SignupResponse }> {
	const res = await fetch("/api/auth/signup", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify(payload),
	});
	// No session comes back: the account only starts working once the link mailed
	// to the recovery address is opened, so there is nothing to persist here.
	const data = (await res.json().catch(() => ({}))) as SignupResponse;
	return { ok: res.ok, data };
}
