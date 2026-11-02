"use client";

import { useLanguage } from "@/components/language-provider";
import { ComposeForm } from "@/components/compose/compose-form";
import { SendGuideBody, useSendAccess } from "@/components/compose/send-access";
import { needsSendGuide } from "@/lib/payments/send-guide";

/**
 * The full-page composer. Reached from the sidebar and from the `c` shortcut,
 * which do not go through `openComposer`, so the same question is asked here: an
 * account that cannot send gets the two ways out instead of an editor whose Send
 * button will be refused.
 */
export default function ComposePage() {
	const { t } = useLanguage();
	const send = useSendAccess();
	const access = send?.access ?? null;
	// The answer arrives in a moment, and the form must not be shown before it: a
	// locked account that starts typing would otherwise watch its letter disappear
	// when the guide replaces the editor.
	const loading = !!send && !send.access;

	return (
		<div className="h-full overflow-auto p-8">
			<div className="mb-6">
				<h1 className="text-2xl font-normal text-neutral-900">{t("compose.pageTitle")}</h1>
				<p className="mt-1 text-sm text-neutral-500">{t("compose.pageDescription")}</p>
			</div>
			{loading ? (
				<p className="py-6 text-sm text-neutral-500">{t("common.loading")}</p>
			) : needsSendGuide(access) ? (
				<div className="max-w-2xl space-y-3">
					<p className="text-sm font-medium text-neutral-900">{t("compose.locked.title")}</p>
					<SendGuideBody access={access} />
				</div>
			) : (
				<ComposeForm mode="page" />
			)}
		</div>
	);
}
