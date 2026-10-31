export type ResendResponse = { ok?: boolean; error?: string };

export async function resendConfirmation(email: string): Promise<{ ok: boolean; data: ResendResponse }> {
	const res = await fetch("/api/auth/verify-email", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		signal: AbortSignal.timeout(30_000),
		body: JSON.stringify({ email: email.trim().toLowerCase() }),
	});
	const data = (await res.json().catch(() => ({}))) as ResendResponse;
	return { ok: res.ok, data };
}
