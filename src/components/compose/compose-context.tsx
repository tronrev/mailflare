"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SendAccessProvider, useSendAccess } from "@/components/compose/send-access";

type ComposeContextValue = {
	open: boolean;
	draftId: string | null;
	openComposer: () => void;
	openDraftComposer: (draftId: string) => void;
	closeComposer: () => void;
	notice: ComposeNotice | null;
	/** Shows a toast; `action` adds a button, `durationMs` overrides the default 3.2s. */
	showNotice: (message: string | null, options?: { action?: { label: string; onClick: () => void }; durationMs?: number }) => void;
};

export type ComposeNotice = {
	message: string;
	action?: { label: string; onClick: () => void };
	durationMs: number;
};

const ComposeContext = createContext<ComposeContextValue | null>(null);

export function useCompose() {
	const ctx = useContext(ComposeContext);
	if (!ctx) throw new Error("useCompose must be used within ComposeProvider");
	return ctx;
}

export function ComposeProvider({ children }: { children: ReactNode }) {
	// The send status is asked for here rather than in each layout, so every screen
	// that can open a composer gets the same answer and the same guide.
	return (
		<SendAccessProvider>
			<ComposeProviderInner>{children}</ComposeProviderInner>
		</SendAccessProvider>
	);
}

function ComposeProviderInner({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const [draftId, setDraftId] = useState<string | null>(null);
	const opener = useRef<HTMLElement | null>(null);
	const sendAccess = useSendAccess();

	function rememberOpener() {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	}
	const [notice, setNotice] = useState<ComposeNotice | null>(null);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), notice.durationMs);
		return () => clearTimeout(timer);
	}, [notice]);

	return (
		<ComposeContext.Provider
			value={{
				open,
				draftId,
				openComposer: () => {
					// A new letter is the moment the account finds out it cannot send;
					// ask first, and let the guide answer for a locked account. Drafts
					// are never blocked — reading and editing one is free.
					const openNew = () => {
						rememberOpener();
						setDraftId(null);
						setOpen(true);
					};
					if (sendAccess) sendAccess.requireSend(openNew);
					else openNew();
				},
				openDraftComposer: (nextDraftId) => {
					if (!open) rememberOpener();
					setDraftId(nextDraftId);
					setOpen(true);
				},
				closeComposer: () => {
					setOpen(false);
					setDraftId(null);
					const previous = opener.current;
					opener.current = null;
					if (previous) requestAnimationFrame(() => { if (previous.isConnected) previous.focus(); });
				},
				notice,
				showNotice: (message, options) => setNotice(message ? { message, action: options?.action, durationMs: options?.durationMs ?? 3200 } : null),
			}}
		>
			{children}
		</ComposeContext.Provider>
	);
}
