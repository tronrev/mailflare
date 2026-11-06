import {
	heuristicTriageCategory,
	htmlToText,
	normalizeTriageCategory,
	type TriageCategory,
} from "./rules";

/**
 * Cheap, fast, and good enough for a six-way choice. Everything that needs
 * precision — the code itself, its lifetime — is read with rules instead, so a
 * model that drifts costs a miscategorised folder, never a wrong passcode.
 */
export const TRIAGE_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export type TriageVerdict = {
	category: TriageCategory;
	/** Whole percent, or null when rules answered. */
	confidence: number | null;
	source: "ai" | "heuristic";
	model: string | null;
};

const SYSTEM_PROMPT = [
	"You label email for a mailbox. Answer with one JSON object and nothing else:",
	'{"category":"<name>","confidence":<0-100>}',
	"Categories:",
	"otp = a one-time passcode, sign-in code or verification code",
	"verify = a sign-up mail asking to confirm an email address by clicking a link",
	"promo = marketing, newsletters, advertising, sales",
	"social = notifications from social networks (follows, mentions, comments)",
	"updates = automated notices about an account or an order: receipts, shipping, invoices, statements, security alerts",
	"important = a human writing to you about work: business, contracts, interviews, recruiting, quotations",
	"other = anything that does not fit",
].join("\n");

/** Body text longer than this buys nothing: the top of a message says what it is. */
const BODY_LIMIT = 1500;

export async function classifyMessage(
	env: CloudflareEnv,
	input: { fromAddr: string | null; subject: string | null; text: string | null; html?: string | null },
): Promise<TriageVerdict> {
	const fallback = (): TriageVerdict => ({
		category: heuristicTriageCategory(input.subject, input.text ?? input.html, input.fromAddr),
		confidence: null,
		source: "heuristic",
		model: null,
	});

	if (!env.AI) return fallback();

	const body = (input.text || htmlToText(input.html) || "").slice(0, BODY_LIMIT);
	const prompt = [
		`From: ${input.fromAddr ?? "(unknown)"}`,
		`Subject: ${input.subject ?? "(none)"}`,
		"",
		body,
	].join("\n");

	try {
		const result = (await env.AI.run(TRIAGE_MODEL, {
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: prompt },
			],
			max_tokens: 60,
			temperature: 0,
		})) as { response?: unknown };
		const parsed = readVerdict(result?.response);
		if (!parsed) return fallback();
		return { category: parsed.category, confidence: parsed.confidence, source: "ai", model: TRIAGE_MODEL };
	} catch (error) {
		console.error("[triage] classification unavailable:", error instanceof Error ? error.message : String(error));
		return fallback();
	}
}

function readVerdict(raw: unknown): { category: TriageCategory; confidence: number | null } | null {
	const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
	const match = text.match(/\{[\s\S]*?\}/);
	if (!match) return null;
	try {
		const value = JSON.parse(match[0]) as { category?: unknown; confidence?: unknown };
		if (typeof value.category !== "string") return null;
		const category = normalizeTriageCategory(value.category, "other");
		const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
			? Math.max(0, Math.min(100, Math.round(value.confidence)))
			: null;
		return { category, confidence };
	} catch {
		return null;
	}
}
