"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Mail, MailPlus } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TurnstileField } from "@/components/auth/turnstile";
import {
  checkSignupPassword,
  checkSignupUsername,
  normalizeSignupUsername,
  SIGNUP_PASSWORD_MIN,
} from "@/lib/auth/signup-rules";
import { submitSignup } from "./utils";

export function SignupClient({ hostname }: { hostname: string | null }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [turnstileReset, setTurnstileReset] = useState(0);

  const preview = hostname && username.trim() ? `${normalizeSignupUsername(username)}@${hostname}` : "";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const chosen = checkSignupUsername(form.get("username"));
    if (!chosen.ok) {
      setError(chosen.error);
      return;
    }
    const password = String(form.get("password") ?? "");
    const passwordProblem = checkSignupPassword(password);
    if (passwordProblem) {
      setError(passwordProblem);
      return;
    }
    if (password !== String(form.get("confirmPassword") ?? "")) {
      setError(t("signup.mismatch"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const { ok, data } = await submitSignup({
        username: chosen.username,
        password,
        recoveryEmail: String(form.get("recoveryEmail") ?? "").trim(),
        turnstileToken: (form.get("turnstileToken") as string | null) ?? undefined,
      });
      if (!ok) {
        setError(data.error ?? t("accounts.createFailed"));
        setTurnstileReset((value) => value + 1);
        return;
      }
      if (data.redirect) {
        const target = new URL(data.redirect, window.location.origin);
        if (data.sentTo) target.searchParams.set("email", data.sentTo);
        router.replace(`${target.pathname}${target.search}`);
      } else {
        router.replace("/verify-email?sent=1");
      }
      router.refresh();
    } catch {
      setError(t("auth.serverUnreachable"));
      setTurnstileReset((value) => value + 1);
    } finally {
      setLoading(false);
    }
  }

  if (!hostname) {
    return (
      <AuthShell
        icon={MailPlus}
        title={t("accounts.createFailed")}
        description="This server has no active domain to hand out addresses from, so sign-ups are closed. Ask the administrator for an account."
      >
        <Button asChild className="h-11 w-full rounded-full px-6">
          <Link href="/login">{t("auth.signIn")}</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      icon={Mail}
      title={t("signup.title")}
      description={t("signup.description")}
      footer={
        <Link href="/login" className="inline-flex items-center gap-2 hover:underline">
          {t("setup.signInInstead")}
        </Link>
      }
    >
      <form method="post" onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="username">{t("setup.username")}</Label>
          <div className="flex items-stretch overflow-hidden rounded-2xl border border-neutral-200 bg-white focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={30}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-describedby="signup-address"
              className="min-w-0 flex-1 border-0 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-neutral-400"
              placeholder="yourname"
            />
            <span className="flex select-none items-center whitespace-nowrap border-l border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-500">
              @{hostname}
            </span>
          </div>
          <p id="signup-address" className="truncate text-xs text-neutral-500">
            {preview || "\u00a0"}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">{t("auth.password")}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={SIGNUP_PASSWORD_MIN}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{t("signup.confirmPassword")}</Label>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={SIGNUP_PASSWORD_MIN}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="recoveryEmail">{t("settings.profile.recoveryTitle")}</Label>
          <Input id="recoveryEmail" name="recoveryEmail" type="email" autoComplete="email" required />
          <p className="text-xs text-neutral-500">{t("verify.recoveryHint")}</p>
        </div>

        {error && (
          <p role="alert" className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </p>
        )}
        <TurnstileField resetSignal={turnstileReset} />
        <Button
          type="submit"
          className="h-11 w-full rounded-full px-6 active:scale-[0.98]"
          disabled={loading}
        >
          {loading ? t("auth.signingIn") : t("home.createAccount")}
        </Button>
      </form>
    </AuthShell>
  );
}
