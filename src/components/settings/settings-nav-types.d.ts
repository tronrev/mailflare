import type { TranslationKey } from "@/lib/i18n/types";

export type SettingsNavItem = {
	href: string;
	labelKey: TranslationKey;
	requiresMailboxAccess?: boolean;
	/**
	 * Hidden from administrators. Sending is metered for everyone else and never
	 * for them, so the page is a collection of offers they cannot accept.
	 */
	adminHidden?: boolean;
};

export type SettingsNavSection = {
	labelKey: TranslationKey;
	items: SettingsNavItem[];
};
