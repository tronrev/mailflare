"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

/**
 * Sending, from the account's point of view.
 *
 * Two ways to qualify, drawn in the order they cost the person: the domain may
 * already send (nothing to do), or they bring their own provider, or they buy
 * time. The page never claims one of those is true — it renders what
 * `/api/billing` says, and a pending order is followed until the chain says it
 * was paid.
 */

type SendStatus = {
	allowed: boolean;
	reason: "domain" | "own" | "paid" | null;
	paidUntil: string | null;
	paidDaysLeft: number;
	own: { provider: "resend" | "ses"; description: string } | null;
	systemProvider: "resend" | "ses" | null;
	canStoreCredentials: boolean;
	pricePerMonth: number;
	months: { min: number; max: number };
	address: string;
	orders?: Order[];
};

type Order = {
	id: string;
	months: number;
	amount: string;
	address: string;
	status: "pending" | "expired" | "paid";
	createdAt: string;
	expiresAt: string;
	txId: string | null;
};

const currency = (value: string) => `${value} USDT`;

export function SendingSettings() {
	const { t } = useLanguage();
	const [status, setStatus] = useState<SendStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [months, setMonths] = useState(1);
	const [order, setOrder] = useState<Order | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [provider, setProvider] = useState<"resend" | "ses">("resend");
	const [fields, setFields] = useState({ apiKey: "", accessKeyId: "", secretAccessKey: "", region: "us-east-1" });
	const pollTimer = useRef<number | null>(null);

	const load = useCallback(async () => {
		const response = await fetch("/api/billing", { cache: "no-store" });
		const body = await response.json().catch(() => null);
		if (!response.ok) throw new Error(body?.error ?? "Could not load sending settings");
		setStatus(body as SendStatus);
		const pending = (body.orders as Order[] | undefined)?.find((item) => item.status === "pending");
		if (pending) setOrder(pending);
		return body as SendStatus;
	}, [t]);

	useEffect(() => {
		let cancelled = false;
		void load().catch((cause: unknown) => {
			if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
		});
		return () => {
			cancelled = true;
		};
	}, [load]);

	// A pending order is followed until it is paid or its window closes. The
	// endpoint throttles the chain read, so polling here is cheap.
	useEffect(() => {
		if (!order || order.status !== "pending") {
			if (pollTimer.current) window.clearInterval(pollTimer.current);
			return;
		}
		pollTimer.current = window.setInterval(() => {
			void fetch(`/api/billing/orders/${order.id}`, { cache: "no-store" })
				.then((response) => response.json())
				.then((body: { order?: Order }) => {
					if (!body.order) return;
					setOrder(body.order);
					if (body.order.status === "paid") void load().catch(() => null);
				})
				.catch(() => null);
		}, 10_000);
		return () => {
			if (pollTimer.current) window.clearInterval(pollTimer.current);
		};
	}, [order, load]);

	async function buy() {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/billing/orders", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ months }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.error ?? "Could not start the order");
			setOrder(body.order as Order);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function saveKey(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/billing/credentials", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider, ...fields }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.error ?? "Could not save the key");
			setStatus(body as SendStatus);
			setFields({ apiKey: "", accessKeyId: "", secretAccessKey: "", region: "us-east-1" });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function removeKey() {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/billing/credentials", { method: "DELETE" });
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error(body?.error ?? "Could not remove the key");
			setStatus(body as SendStatus);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	if (!status && !error) return <p className="py-6 text-sm text-neutral-500">{t("common.loading")}</p>;

	return (
		<div className="space-y-8">
			<Card>
				<CardHeader>
					<CardTitle>{t("settings.sending.title")}</CardTitle>
					<CardDescription>
						{status?.reason === "domain"
							? t("settings.sending.statusDomain")
							: status?.reason === "own" && status.own
								? t("settings.sending.statusOwn", { provider: status.own.description })
								: status?.reason === "paid" && status.paidUntil
									? t("settings.sending.statusPaid", { date: status.paidUntil.slice(0, 10), days: status.paidDaysLeft })
									: t("settings.sending.statusLocked")}
					</CardDescription>
				</CardHeader>
				{error ? (
					<CardContent>
						<p className="pb-4 text-sm text-red-600">{error}</p>
					</CardContent>
				) : null}
			</Card>

			{status && status.reason !== "domain" ? (
				<Card>
					<CardHeader>
						<CardTitle>{t("settings.sending.buy")}</CardTitle>
						<CardDescription>{t("settings.sending.buyHint")}</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4 pb-6">
						{status.systemProvider ? (
							<>
								<div className="flex items-end gap-3">
									<div className="space-y-2">
										<Label htmlFor="months">{t("settings.sending.months")}</Label>
										<Select id="months" value={months} onChange={(event) => setMonths(Number(event.target.value))}>
											{Array.from({ length: status.months.max - status.months.min + 1 }, (_, index) => status.months.min + index).map(
												(value) => (
													<option key={value} value={value}>
														{value}
													</option>
												),
											)}
										</Select>
									</div>
									<Button type="button" onClick={() => void buy()} disabled={busy}>
										{t("settings.sending.buy")}
									</Button>
								</div>
								{order && order.status !== "paid" ? (
									<div className="space-y-2 rounded-lg border border-neutral-200 p-4">
										<p className="text-sm">
											{t("settings.sending.pay", { amount: currency(order.amount), address: order.address })}
										</p>
										<div className="flex items-center gap-2">
											<code className="rounded bg-neutral-100 px-2 py-1 text-sm">{order.amount}</code>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => {
													void navigator.clipboard?.writeText(order.amount).then(() => {
														setCopied(true);
														window.setTimeout(() => setCopied(false), 1500);
													});
												}}
											>
												<Copy className="mr-1 h-3.5 w-3.5" />
												{copied ? t("common.copied") : t("common.copy")}
											</Button>
											<code className="truncate rounded bg-neutral-100 px-2 py-1 text-xs">{order.address}</code>
										</div>
										<p className="text-xs text-neutral-500">{t("settings.sending.payWindow")}</p>
										<Badge variant={order.status === "pending" ? "secondary" : "outline"}>
											{order.status === "pending" ? t("settings.sending.waiting") : order.status}
										</Badge>
									</div>
								) : null}
							</>
						) : (
							<p className="text-sm text-neutral-500">{t("settings.sending.notSold")}</p>
						)}
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>{t("settings.sending.ownTitle")}</CardTitle>
					<CardDescription>{status?.own?.description ?? t("settings.sending.ownHint")}</CardDescription>
				</CardHeader>
				<CardContent className="pb-6">
					{status && !status.canStoreCredentials ? (
						<p className="text-sm text-neutral-500">{t("settings.sending.cannotStore")}</p>
					) : (
						<form className="space-y-3" onSubmit={(event) => void saveKey(event)}>
							<Select value={provider} onChange={(event) => setProvider(event.target.value as "resend" | "ses")}>
								<option value="resend">Resend</option>
								<option value="ses">Amazon SES</option>
							</Select>
							{provider === "resend" ? (
								<div className="space-y-2">
									<Label htmlFor="apiKey">Resend API key</Label>
									<Input
										id="apiKey"
										type="password"
										autoComplete="off"
										value={fields.apiKey}
										onChange={(event) => setFields({ ...fields, apiKey: event.target.value })}
										placeholder="re_..."
									/>
								</div>
							) : (
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="accessKeyId">Access key ID</Label>
										<Input
											id="accessKeyId"
											value={fields.accessKeyId}
											onChange={(event) => setFields({ ...fields, accessKeyId: event.target.value })}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="secretAccessKey">Secret access key</Label>
										<Input
											id="secretAccessKey"
											type="password"
											autoComplete="off"
											value={fields.secretAccessKey}
											onChange={(event) => setFields({ ...fields, secretAccessKey: event.target.value })}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="region">Region</Label>
										<Input
											id="region"
											value={fields.region}
											onChange={(event) => setFields({ ...fields, region: event.target.value })}
										/>
									</div>
								</div>
							)}
							<div className="flex gap-2">
								<Button type="submit" disabled={busy}>
									{t("settings.sending.saveKey")}
								</Button>
								{status?.own ? (
									<Button type="button" variant="ghost" onClick={() => void removeKey()} disabled={busy}>
										{t("settings.sending.removeKey")}
									</Button>
								) : null}
							</div>
						</form>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
