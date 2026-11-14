import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/cloudflare";
import { ACCOUNTS_COOKIE, parseAccountTokens, resolveAccounts } from "@/lib/auth/accounts";
import { getSessionTokenFromRequestHeaders } from "@/lib/auth/session";
import { describeDatabaseError } from "@/lib/database-errors";

/** Accounts signed in on this browser. Tokens are never returned. */
export async function GET(request: Request) {
	const env = getEnv();
	const jar = await cookies();
	const active = getSessionTokenFromRequestHeaders(request);
	// Include the current session so accounts signed in before this cookie existed still list.
	let accounts: Awaited<ReturnType<typeof resolveAccounts>> = [];
	try {
		accounts = await resolveAccounts(
			env,
			Array.from(new Set(parseAccountTokens(jar.get(ACCOUNTS_COOKIE)?.value).concat(active ?? []))),
		);
	} catch (error) {
		// Switching accounts is a convenience. A database that is missing a
		// migration must not turn the header into a failed request.
		console.error("Could not resolve signed-in accounts", describeDatabaseError(error));
	}
	const response = NextResponse.json({
		accounts: accounts.map(({ token, avatarKey, ...account }) => ({ ...account, active: token === active })),
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
}
