import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getUserFromSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { listActiveDomainHostnames } from "@/lib/domains/service";
import { authPageMetadata } from "../auth-metadata";
import { LoginClient } from "./login-client";

export const dynamic = "force-dynamic";

export const generateMetadata = () => authPageMetadata("auth.signIn");

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ add?: string }> }) {
	const adding = (await searchParams).add === "1";
	const env = getEnv();
	if (!(await hasAdminAccount(env))) redirect("/setup");
	const cookieStore = await cookies();
	const user = await getUserFromSession(env, cookieStore.get(SESSION_COOKIE)?.value);
	if (user && !user.disabled && !adding) redirect("/inbox");

	// The email field completes the address from the domains this deployment
	// receives mail for. A failure here means "nothing to suggest", which the
	// field already handles.
	const domains = await listActiveDomainHostnames(env).catch(() => []);
	const hostname = (await headers()).get("host") ?? "";

	return (
		<AuthGuard mode="public" allowAuthenticated={adding}>
			<LoginClient adding={adding} domains={domains} hostname={hostname} />
		</AuthGuard>
	);
}
