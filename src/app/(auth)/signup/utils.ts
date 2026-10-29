import { persistAuthSession } from "@/lib/auth/client";

export type SignupResponse = {
	ok?: boolean;
	token?: string;
	redirect?: string;
	email?: string;
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
	// The session token arrives with the account, so the person lands in their
	// inbox already signed in instead of retyping the password they just chose.
	return { ok: res.ok, data: (await persistAuthSession(res)) as SignupResponse };
}
