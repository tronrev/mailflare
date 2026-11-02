"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { needsSendGuide, type SendAccessView } from "@/lib/payments/send-guide";

/**
 * Whether this account may send, and what to offer when it may not.
 *
 * `/inbox` is where the answer becomes visible: a mailbox can receive all day and
 * still have no way to send, and the account only finds out after writing a
 * letter and pressing send. So Compose asks here first — one small request, made
 * once per layout — and a locked account gets the two ways out (buy sending time,
 * or bring a provider key) instead of an editor that cannot deliver.
 *
 * Nothing is enforced by this: `/api/send` refuses on its own. This exists to say
 * why before the effort is spent.
 */

export type SendAccess = SendAccessView & {
	reason: "domain" | "own" | "paid" | null;
	buyingOffered: boolean;
	canStoreCredentials: boolean;
	pricePerMonth: number;
};

type SendAccessContextValue = {
	access: SendAccess | null;
	refresh: () => Promise<SendAccess | null>;
	/** Runs `action` when the account may send, and opens the guide otherwise. */
	requireSend: (action: () => void) => void;
	openGuide: () => void;
};

const SendAccessContext = createContext<SendAccessContextValue | null>(null);

/** Null outside a provider, so a layout that never mounted one simply is not gated. */
export function useSendAccess(): SendAccessContextValue | null {
	return useContext(SendAccessContext);
}

export function SendAccessProvider({ children }: { children: ReactNode }) {
	const [access, setAccess] = useState<SendAccess | null>(null);
	const [guideOpen, setGuideOpen] = useState(false);
	// A ref as well as state: `requireSend` must see the answer even when it arrives
	// between the click and the re-render.
	const latest = useRef<SendAccess | null>(null);

	const refresh = useCallback(async () => {
		try {
			const response = await fetch("/api/billing/access", { cache: "no-store" });
			if (!response.ok) return null;
			const body = (await response.json()) as SendAccess;
			latest.current = body;
			setAccess(body);
			return body;
		} catch {
			// Unknown is not a refusal: a failed status call must not stand between
			// somebody who can send and their composer.
			return null;
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const requireSend = useCallback(
		(action: () => void) => {
			const current = latest.current;
			if (current) {
				if (needsSendGuide(current)) setGuideOpen(true);
				else action();
				return;
			}
			void refresh().then((next) => {
				if (needsSendGuide(next)) setGuideOpen(true);
				else action();
			});
		},
		[refresh],
	);

	return (
		<SendAccessContext.Provider value={{ access, refresh, requireSend, openGuide: () => setGuideOpen(true) }}>
			{children}
			<SendGuideDialog open={guideOpen} onOpenChange={setGuideOpen} access={access} />
		</SendAccessContext.Provider>
	);
}

/** The two ways to qualify, or the honest answer when this server offers neither. */
export function SendGuideBody({ access }: { access: SendAccess | null }) {
	const { t } = useLanguage();
	const buy = access?.buyingOffered ?? false;
	const ownKey = access?.canStoreCredentials ?? false;
	if (!buy && !ownKey) return <p className="text-sm text-neutral-600">{t("compose.locked.unavailable")}</p>;
	return (
		<div className="space-y-3">
			<p className="text-sm text-neutral-600">{t("compose.locked.body")}</p>
			{buy ? (
				<div className="rounded-xl border border-neutral-200 p-4">
					<p className="text-sm font-medium text-neutral-900">{t("compose.locked.buyTitle")}</p>
					<p className="mt-1 text-sm text-neutral-500">
						{t("compose.locked.buyHint", { price: access?.pricePerMonth ?? 1 })}
					</p>
					<Button asChild size="sm" className="mt-3">
						<Link href="/settings/sending#buy">{t("compose.locked.openBuy")}</Link>
					</Button>
				</div>
			) : (
				<p className="text-sm text-neutral-500">{t("compose.locked.notOffered")}</p>
			)}
			{ownKey ? (
				<div className="rounded-xl border border-neutral-200 p-4">
					<p className="text-sm font-medium text-neutral-900">{t("compose.locked.ownTitle")}</p>
					<p className="mt-1 text-sm text-neutral-500">{t("compose.locked.ownHint")}</p>
					<Button asChild size="sm" variant="outline" className="mt-3">
						<Link href="/settings/sending#own">{t("compose.locked.openOwn")}</Link>
					</Button>
				</div>
			) : null}
		</div>
	);
}

function SendGuideDialog({
	open,
	onOpenChange,
	access,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	access: SendAccess | null;
}) {
	const { t } = useLanguage();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("compose.locked.title")}</DialogTitle>
					<DialogDescription>{t("compose.locked.subtitle")}</DialogDescription>
				</DialogHeader>
				<SendGuideBody access={access} />
				<div className="mt-5 flex justify-end">
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						{t("compose.locked.later")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
