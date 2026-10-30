import { redirect } from "next/navigation";
import { AuthGuard } from "@/components/auth/auth-guard";
import { hasAdminAccount } from "@/lib/auth/setup";
import { getSignupDomain } from "@/lib/auth/signup";
import { getEnv } from "@/lib/cloudflare";
import { SignupClient } from "./signup-client";

export const dynamic = "force-dynamic";

export default async function SignupPage() {
	const env = getEnv();
	// Before the first account exists there is nothing to join yet: that state is
	// the install wizard's, not a sign-up form's.
	if (!(await hasAdminAccount(env))) redirect("/setup");

	// A fresh install may still be missing the domains table; a failure here means
	// "no address to hand out", which the page already knows how to say.
	const domain = await getSignupDomain(env).catch(() => null);

	return (
		<AuthGuard mode="public">
			<SignupClient hostname={domain?.hostname ?? null} />
		</AuthGuard>
	);
}
