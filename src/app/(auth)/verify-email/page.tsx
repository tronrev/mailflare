import { Suspense } from "react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { authPageMetadata } from "../auth-metadata";
import { VerifyEmailClient } from "./verify-client";

export const dynamic = "force-dynamic";

export const generateMetadata = () => authPageMetadata("verify.title");

export default function VerifyEmailPage() {
	return (
		<AuthGuard mode="public">
			<Suspense>
				<VerifyEmailClient />
			</Suspense>
		</AuthGuard>
	);
}
