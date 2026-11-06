import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { folders } from "@/db/schema";
import { newId } from "@/lib/ids";
import { triageFolderFor, type TriageCategory } from "./rules";

/**
 * The folder a category files into, created the first time it is needed.
 *
 * Names are fixed English words on purpose: a folder is user data that shows up
 * in IMAP and JMAP clients too, so it cannot follow the interface language of
 * whoever happened to receive the first promotional mail.
 */
export async function ensureCategoryFolder(
	db: AppDatabase,
	userId: string,
	mailboxId: string,
	category: TriageCategory,
): Promise<string | null> {
	const definition = triageFolderFor(category);
	if (!definition) return null;

	const find = () =>
		db
			.select({ id: folders.id })
			.from(folders)
			.where(and(eq(folders.mailboxId, mailboxId), eq(folders.name, definition.name)))
			.limit(1);

	const [existing] = await find();
	if (existing) return existing.id;

	// Two messages arriving together can both try to create it; the unique index
	// on (mailbox_id, name) decides, and the loser re-reads the winner's row.
	await db
		.insert(folders)
		.values({
			id: newId("fld"),
			userId,
			mailboxId,
			name: definition.name,
			color: definition.color,
		})
		.onConflictDoNothing();
	const [created] = await find();
	return created?.id ?? null;
}
