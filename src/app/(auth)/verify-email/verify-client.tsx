"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { MailCheck } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resendConfirmation } from "./utils";

export function VerifyEmailClient() {
	const { t } = useLanguage();
	const params = useSearchParams();
	const invalid = params.get("state") === "invalid";
	const sentTo = params.get("email") ?? "";
	const [email, setEmail] = useState(sentTo);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setLoading(true);
		setError(null);
		setMessage(null);
		try {
			const result = await resendConfirmation(email);
			if (!result.ok) {
				setError(result.error ?? t("auth.serverUnreachable"));
				return;
			}
			setMessage(t("verify.resent"));
		} catch {
			setError(t("auth.serverUnreachable"));
		} finally {
			setLoading(false);
		}
	}

	return (
		<AuthShell
			icon={MailCheck}
			title={invalid ? t("verify.invalidTitle") : t("verify.title")}
			description={invalid ? t("verify.invalid") : t("verify.description", { email: sentTo || t("settings.profile.recoveryTitle") })}
			footer={
				<Link href="/login" className="inline-flex items-center gap-2 hover:underline">
					{t("auth.signIn")}
				</Link>
			}
		>
			<form method="post" onSubmit={onSubmit} className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="email">{t("settings.profile.recoveryTitle")}</Label>
					<Input
						id="email"
						name="email"
						type="email"
						autoComplete="email"
						required
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
				</div>
				{message && (
					<p role="status" className="rounded-2xl border border-green-100 bg-green-50 px-4 py-3 text-sm font-medium text-green-800">
						{message}
					</p>
				)}
				{error && (
					<p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
						{error}
					</p>
				)}
				<Button type="submit" className="h-11 w-full rounded-full px-6 active:scale-[0.98]" disabled={loading}>
					{loading ? t("auth.signingIn") : t("auth.reset.requestNew")}
				</Button>
			</form>
		</AuthShell>
	);
}
