import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { describeDatabaseError, isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { getMessageWithBodyForUser } from "@/lib/email/inbound";

type MessageRouteParams = {
	params: Promise<{ messageId: string }>;
};

export async function GET(request: Request, { params }: MessageRouteParams) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { messageId } = await params;
	try {
		const data = await getMessageWithBodyForUser(env, user, messageId);
		if (!data) {
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		}
		return NextResponse.json(data);
	} catch (error) {
		// An uncaught Worker error answers with an empty body, which the reader
		// cannot parse, so it stays on its skeleton forever. Answer in JSON, and
		// when the cause is an unapplied migration, say which fix applies.
		const pendingMigration = isMissingTableError(error) || isMissingColumnError(error);
		console.error("Could not load message", describeDatabaseError(error));
		return NextResponse.json(
			{
				error: pendingMigration
					? "This deployment has a database migration pending, so the message cannot be read yet. Apply the pending migrations from Admin settings and reload."
					: "Could not load this message. Please try again.",
				code: pendingMigration ? "MIGRATION_REQUIRED" : "MESSAGE_LOAD_FAILED",
			},
			{ status: pendingMigration ? 409 : 500 },
		);
	}
}
