import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { messageTriage, messages, users } from "@/db/schema";
import { classifyMessage } from "./classify";
import { ensureCategoryFolder } from "./folders";
import {
	extractOtpCode,
	guessOtpProvider,
	looksLikeOtp,
	parseOtpLifetimeMinutes,
	splitSender,
	triageFolderFor,
	triageRetentionUntil,
	type TriageCategory,
} from "./rules";

export type TriageInput = {
	messageId: string;
	userId: string;
	mailboxId: string;
	fromAddr: string;
	subject: string | null;
	text: string | null;
	html: string | null;
	receivedAt: Date;
	/** Set when a mailbox rule already filed the message: that decision wins. */
	folderId: string | null;
};

/**
 * Decide what an inbound message is, file it, and remember when it should go.
 *
 * Never throws: a mailbox that cannot be triaged is a mailbox that works the way
 * it did before this feature existed, which is a much better outcome than a
 * message that never arrives.
 */
export async function triageInboundMessage(env: CloudflareEnv, input: TriageInput): Promise<void> {
	if (input.folderId) return;
	const db = getDb(env);

	const [alreadyTriaged] = await db
		.select({ messageId: messageTriage.messageId })
		.from(messageTriage)
		.where(eq(messageTriage.messageId, input.messageId))
		.limit(1);
	if (alreadyTriaged) return;

	const [owner] = await db
		.select({ enabled: users.autoTriageEnabled })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);
	if (owner && owner.enabled === false) return;

	const sender = splitSender(input.fromAddr);
	const verdict = looksLikeOtp(input.subject, input.text)
		? { category: "otp" as TriageCategory, confidence: null, source: "heuristic" as const, model: null }
		: await classifyMessage(env, input);

	const isOtp = verdict.category === "otp";
	const otpCode = isOtp ? extractOtpCode({ subject: input.subject, text: input.text }) : null;
	const otpLifetime = isOtp ? parseOtpLifetimeMinutes(`${input.subject ?? ""}\n${input.text ?? ""}`) : null;
	const otpProvider = isOtp ? guessOtpProvider(sender.address, sender.displayName) : null;

	// A message that mentions a code but contains none is an announcement, not a
	// passcode: keeping it forever is the honest answer.
	const category: TriageCategory = isOtp && !otpCode ? "updates" : verdict.category;
	const retainUntil = triageRetentionUntil(category, input.receivedAt, otpLifetime);

	const folderId = await fileIntoFolder(db, input, category);
	const otpExpiresAt = category === "otp" ? retainUntil : null;

	await db
		.insert(messageTriage)
		.values({
			messageId: input.messageId,
			userId: input.userId,
			mailboxId: input.mailboxId,
			category,
			confidence: verdict.confidence,
			source: verdict.source,
			model: verdict.model,
			otpProvider: category === "otp" ? otpProvider : null,
			otpCode: category === "otp" ? otpCode : null,
			otpExpiresAt,
			retainUntil,
		})
		.onConflictDoNothing();

	console.info(JSON.stringify({
		triage: input.messageId,
		category,
		source: verdict.source,
		folderId,
		otp: category === "otp" ? { provider: otpProvider, expiresAt: otpExpiresAt?.toISOString() ?? null } : null,
	}));
}

async function fileIntoFolder(
	db: ReturnType<typeof getDb>,
	input: TriageInput,
	category: TriageCategory,
): Promise<string | null> {
	if (!triageFolderFor(category)) return null;
	try {
		const folderId = await ensureCategoryFolder(db, input.userId, input.mailboxId, category);
		if (!folderId) return null;
		// The user may have moved the message while the model was thinking.
		await db
			.update(messages)
			.set({ folderId })
			.where(and(eq(messages.id, input.messageId), isNull(messages.folderId)));
		return folderId;
	} catch (error) {
		console.error(`[triage] could not file ${input.messageId}:`, error instanceof Error ? error.message : String(error));
		return null;
	}
}
