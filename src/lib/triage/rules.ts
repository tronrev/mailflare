/**
 * Mail triage rules: the categories, the folder each one falls into, how long a
 * message in each category is kept, and how a one-time passcode is read out of
 * a message.
 *
 * Kept free of imports on purpose: the queue consumer, the public API and the
 * tests all need exactly these answers, and a module with no dependencies can
 * be reasoned about (and run) on its own.
 */

export const TRIAGE_CATEGORIES = ["otp", "promo", "social", "updates", "important", "other"] as const;
export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];

/**
 * Categories that get their own folder. `important` and `other` deliberately
 * stay in the Inbox: mail that needs a human is the one thing a triage system
 * must not hide behind a click.
 */
export const TRIAGE_FOLDERS: Partial<Record<TriageCategory, { name: string; color: string }>> = {
	otp: { name: "OTP", color: "#dc2626" },
	promo: { name: "Promotions", color: "#f59e0b" },
	social: { name: "Social", color: "#8b5cf6" },
	updates: { name: "Updates", color: "#0ea5e9" },
};

/** `null` means keep forever. `otp` is measured from the code's own lifetime. */
export const CATEGORY_RETENTION_DAYS: Record<TriageCategory, number | null> = {
	otp: null,
	promo: 30,
	social: 90,
	updates: 90,
	important: null,
	other: null,
};

export const OTP_MIN_LIFETIME_MINUTES = 5;
export const OTP_MAX_LIFETIME_MINUTES = 24 * 60;
export const OTP_DEFAULT_LIFETIME_MINUTES = 10;

const categorySet = new Set<string>(TRIAGE_CATEGORIES);

export function isTriageCategory(value: unknown): value is TriageCategory {
	return typeof value === "string" && categorySet.has(value);
}

/** Models like to answer with prose; take the first name that is actually one of ours. */
export function normalizeTriageCategory(value: unknown, fallback: TriageCategory = "other"): TriageCategory {
	if (isTriageCategory(value)) return value;
	if (typeof value !== "string") return fallback;
	const lowered = value.trim().toLowerCase();
	if (isTriageCategory(lowered)) return lowered;
	if (/\botp\b|passcode|verification code/.test(lowered)) return "otp";
	if (/promo|market|advert|newsletter|offer|spam/.test(lowered)) return "promo";
	if (/social|friend|follow/.test(lowered)) return "social";
	if (/update|receipt|invoice|shipping|notification|alert/.test(lowered)) return "updates";
	if (/important|business|\bwork\b|interview|recruit|contract/.test(lowered)) return "important";
	return fallback;
}

export function triageFolderFor(category: TriageCategory) {
	return TRIAGE_FOLDERS[category] ?? null;
}

/**
 * When a message in this category should be deleted. Computed once, at
 * classification time, and stored on the row: changing the policy later is a
 * decision about future mail, not a retroactive one.
 */
export function triageRetentionUntil(
	category: TriageCategory,
	receivedAt: Date,
	otpLifetimeMinutes?: number | null,
): Date | null {
	if (category === "otp") {
		const minutes = clampOtpLifetimeMinutes(otpLifetimeMinutes ?? OTP_DEFAULT_LIFETIME_MINUTES);
		return new Date(receivedAt.getTime() + minutes * 60_000);
	}
	const days = CATEGORY_RETENTION_DAYS[category];
	if (!days) return null;
	return new Date(receivedAt.getTime() + days * 86_400_000);
}

export function clampOtpLifetimeMinutes(minutes: number): number {
	if (!Number.isFinite(minutes) || minutes <= 0) return OTP_DEFAULT_LIFETIME_MINUTES;
	return Math.min(OTP_MAX_LIFETIME_MINUTES, Math.max(OTP_MIN_LIFETIME_MINUTES, Math.round(minutes)));
}

const OTP_KEYWORDS =
	/(验证码|校验码|动态码|确认码|登录码|安全码|verification\s+code|verify\s+code|security\s+code|one[\s-]?time\s+(?:code|password|passcode|pin)|\botp\b|\bpasscode\b|\b2fa\b|auth(?:entication)?\s+code|sign[\s-]?in\s+code)/i;

/** Cheap pre-check: a message that never mentions a code is not an OTP message. */
export function looksLikeOtp(subject: string | null | undefined, text: string | null | undefined): boolean {
	if (subject && OTP_KEYWORDS.test(subject)) return true;
	if (!text) return false;
	return OTP_KEYWORDS.test(text.slice(0, 2000));
}

/**
 * Reads the code out of the message.
 *
 * Subject beats body, six digits beat four, and a candidate that sits next to
 * the word "code" beats one that does not — the numbers in a footer (unsubscribe
 * id, order number, price) are exactly what this has to avoid.
 */
export function extractOtpCode(input: { subject?: string | null; text?: string | null }): string | null {
	const best = pickOtpCandidate(input.subject ?? "", 3) ?? pickOtpCandidate((input.text ?? "").slice(0, 4000), 1);
	return best;
}

function pickOtpCandidate(source: string, fieldWeight: number): string | null {
	if (!source) return null;
	type Candidate = { code: string; score: number };
	const candidates = new Map<string, Candidate>();
	const consider = (code: string, index: number, kind: "digits" | "alnum") => {
		if (kind === "digits") {
			// Years, prices and long ids are not codes.
			if (/^(19|20)\d{2}$/.test(code)) return;
			if (code.length > 8) return;
		}
		const nearKeyword = OTP_KEYWORDS.test(source.slice(Math.max(0, index - 60), index + 60));
		let score = fieldWeight;
		if (nearKeyword) score += 6;
		if (code.length === 6) score += 2;
		if (code.length === 4) score -= 2;
		if (kind === "alnum") score += 1;
		if (/(?:^|[\s¥$€£₹])\d+[.,]\d{2}\b/.test(source.slice(Math.max(0, index - 3), index + code.length + 3))) score -= 4;
		const previous = candidates.get(code);
		if (!previous || previous.score < score) candidates.set(code, { code, score });
	};

	for (const match of source.matchAll(/(?<![\w+])(\d{4,8})(?![\w+])/g)) {
		consider(match[1], match.index ?? 0, "digits");
	}
	for (const match of source.matchAll(/(?<![\w])([A-Z0-9]{6})(?![\w])/g)) {
		const code = match[1];
		if (!/\d/.test(code) || !/[A-Z]/.test(code)) continue;
		consider(code, match.index ?? 0, "alnum");
	}

	let best: Candidate | null = null;
	for (const candidate of candidates.values()) {
		if (!best || candidate.score > best.score) best = candidate;
	}
	// Below this, the number is just a number: an invoice id, a tracking number, a
	// phone extension. A code has to be in the subject or sit next to the word.
	return best && best.score >= 4 ? best.code : null;
}

const LIFETIME_PATTERNS: RegExp[] = [
	/(?:有效期(?:为)?|请在|须在|valid\s+for|expires?\s+(?:in|after)|expiring\s+in|use\s+within|within)\s*(\d{1,4})\s*(秒钟|秒|分钟|分|小时|钟头|days?|天|hours?|hrs?|minutes?|mins?|seconds?|secs?)/i,
	/(\d{1,4})\s*(分钟|分|hours?|hrs?|minutes?|mins?|days?|天)(?:内|之内)?\s*(?:有效|有效期内)/i,
];

/** How long the code stays usable, in minutes, or null when the mail never says. */
export function parseOtpLifetimeMinutes(text: string | null | undefined): number | null {
	if (!text) return null;
	const source = text.slice(0, 4000);
	for (const pattern of LIFETIME_PATTERNS) {
		const match = source.match(pattern);
		if (!match) continue;
		const amount = Number(match[1]);
		if (!Number.isFinite(amount) || amount <= 0) continue;
		const unit = match[2].toLowerCase();
		const minutes = /秒|seconds?|secs?/.test(unit)
			? amount / 60
			: /小时|钟头|hours?|hrs?/.test(unit)
				? amount * 60
				: /天|days?/.test(unit)
					? amount * 1440
					: amount;
		return clampOtpLifetimeMinutes(minutes);
	}
	return null;
}

const GENERIC_SENDERS = /^(no[\s-]?reply|noreply|notifications?|support|security|verify|verification|accounts?|team|info|hello|mailer|admin)$/i;
/**
 * Who the code came from. The display name is usually the product ("GitHub",
 * "Steam"); when it is a generic one, the domain is the better answer.
 */
export function guessOtpProvider(fromAddr: string | null | undefined, displayName?: string | null): string | null {
	const name = (displayName ?? "").replace(/^["']|["']$/g, "").trim();
	if (name && name.length <= 40 && !GENERIC_SENDERS.test(name)) return name;
	const address = (fromAddr ?? "").trim();
	const at = address.lastIndexOf("@");
	if (at < 0) return name || null;
	const domain = address.slice(at + 1).toLowerCase().replace(/[>)\s].*$/, "");
	const labels = domain.split(".").filter(Boolean);
	if (labels.length < 2) return domain || null;
	const skip = new Set(["www", "mail", "email", "smtp", "mg", "em", "e", "no-reply", "noreply", "account", "accounts", "auth", "login", "notify", "notifications", "secure", "click"]);
	let index = 0;
	while (index < labels.length - 1 && skip.has(labels[index])) index += 1;
	const label = labels[index];
	if (!label) return domain || null;
	return label.replace(/^./, (char) => char.toUpperCase());
}

/** `"GitHub" <noreply@github.com>` → `{ displayName: "GitHub", address: "noreply@github.com" }`. */
export function splitSender(fromAddr: string | null | undefined): { displayName: string | null; address: string } {
	const raw = (fromAddr ?? "").trim();
	if (!raw) return { displayName: null, address: "" };
	const angle = raw.match(/^(.*)<([^>]+)>$/);
	if (!angle) return { displayName: null, address: raw };
	const displayName = angle[1].trim().replace(/^["']|["']$/g, "").trim() || null;
	return { displayName, address: angle[2].trim() };
}

/**
 * What a rule-based classifier would say, used when Workers AI is unavailable,
 * over budget, or answers with something that is not one of our names. Crude on
 * purpose: a wrong guess costs a message in the wrong folder, a missing answer
 * costs the whole feature.
 */
export function heuristicTriageCategory(
	subject: string | null | undefined,
	text: string | null | undefined,
	fromAddr: string | null | undefined,
): TriageCategory {
	const haystack = `${subject ?? ""}\n${(text ?? "").slice(0, 2000)}\n${fromAddr ?? ""}`;
	const scores: Record<Exclude<TriageCategory, "otp">, number> = {
		promo: countMatches(haystack, PROMO_PATTERNS),
		social: countMatches(haystack, SOCIAL_PATTERNS),
		updates: countMatches(haystack, UPDATE_PATTERNS),
		important: countMatches(haystack, IMPORTANT_PATTERNS) * 1.2,
		other: 0,
	};
	// Bulk mail that also mentions "invoice" is still bulk: an unsubscribe link
	// settles it before anything else is weighed.
	if (/unsubscribe|退订|取消订阅/i.test(haystack)) scores.promo += 2;
	const ranked = (Object.entries(scores) as Array<[Exclude<TriageCategory, "otp">, number]>)
		.sort((a, b) => b[1] - a[1]);
	const [category, score] = ranked[0];
	return score > 0 ? category : "other";
}

function countMatches(source: string, patterns: RegExp[]): number {
	let total = 0;
	for (const pattern of patterns) {
		const matches = source.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
		if (matches) total += Math.min(matches.length, 3);
	}
	return total;
}

const PROMO_PATTERNS = [
	/newsletter|促销|优惠|折扣|特价|限时|优惠券|coupon|discount|% off|free shipping|包邮|清仓|大促|新品上市/i,
	/\bsale\b|\bdeals?\b|\bsave \d+%|\boffer ends?/i,
	/unsubscribe|退订/i,
];
const SOCIAL_PATTERNS = [
	/facebook|instagram|linkedin|twitter|weibo|微博|小红书|抖音|tiktok|youtube|douyin/i,
	/follower|followed you|mentioned you|点赞|关注了你|@了你|好友申请|commented on your/i,
];
const UPDATE_PATTERNS = [
	/order (?:confirmed|shipped|delivered)|your order|shipping|tracking number|已发货|已签收|订单/i,
	/receipt|payment received|账单|statement|security alert|new sign-in|password (?:changed|reset)|system status|maintenance|续费|expires? soon/i,
];
const IMPORTANT_PATTERNS = [
	/面试|interview|简历|resume|\bcv\b|offer letter|录用|招聘|recruit|合同|contract|agreement|报价|quotation|proposal|purchase order|采购/i,
	/会议|meeting|please review|请确认|请回复|deadline|invoice attached|待您确认/i,
];
