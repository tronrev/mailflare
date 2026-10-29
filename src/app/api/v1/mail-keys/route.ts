import { NextResponse } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { apiKeys, domains, mailboxes, mcpKeyMailboxes, users } from "@/db/schema";
import { authenticateAdminApiKey } from "@/lib/api/admin-auth";
import { generateApiKey, parseScopes, scopesToJson } from "@/lib/api-keys";
import { ADMIN_API_KEY_SCOPES } from "@/lib/api/scopes";
import { newId } from "@/lib/ids";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { SessionUser } from "@/lib/auth/types";

/**
 * Mail keys are deliberately separate from admin keys: `authenticateApiKeyValue`
 * strips every non-admin scope from a key that carries one, and
 * `GET /api/v1/messages` needs `read`. So an admin key can never read mail, and a
 * script holding only admin credentials cannot mint one through the session-only
 * `/api/api-keys`. This route closes that gap for deployments that automate their
 * own mailboxes: an admin key with the `mailboxes` scope issues a mailbox-scoped
 * personal key. Least privilege — `read` (optionally `jmap`), never `send`, never
 * calendar scopes — and it stays limited to the mailboxes named in the request.
 *
 * The key also carries the identity that read access is checked against, so a key
 * for a child account's mailbox is issued **as that account** (`resolveKeyOwner`).
 * Without that the secret would be valid, whitelisted, and still answer `404`: the
 * whitelist narrows what a key may touch, it does not grant the owner's rights.
 */
const MAIL_KEY_SCOPES = ["read", "jmap"] as const;

const createMailKeySchema = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	mailboxIds: z.array(z.string().min(1)).min(1).max(30),
	scopes: z.array(z.enum(MAIL_KEY_SCOPES)).min(1).optional(),
});

const ADMIN_SCOPES = new Set<string>(ADMIN_API_KEY_SCOPES);

function isMailKey(scopes: string[]): boolean {
	return scopes.some((scope) => (MAIL_KEY_SCOPES as readonly string[]).includes(scope)) && !scopes.some((scope) => ADMIN_SCOPES.has(scope));
}

/** Mailboxes this admin may hand out: their own, or ones owned by accounts they created. */
async function accessibleMailboxes(env: CloudflareEnv, userId: string, ids: string[]) {
	return getDb(env)
		.select({
			id: mailboxes.id,
			localPart: mailboxes.localPart,
			ownerUserId: mailboxes.userId,
			hostname: domains.hostname,
		})
		.from(mailboxes)
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(and(inArray(mailboxes.id, ids), or(eq(mailboxes.userId, userId), eq(users.createdByUserId, userId))));
}

/**
 * Who the issued key must belong to.
 *
 * `GET /api/v1/messages` decides access with `getMailboxAccessLevel`, which only
 * grants `canRead` to the mailbox **owner** (or a delegated teammate) — a key's
 * whitelist alone is not enough. So a key minted for a child account's mailbox has
 * to carry that account's identity: if it stayed on the admin it would be freshly
 * issued and still answer `404` on every read. When the admin can already read the
 * mailbox himself (own mailbox, or shared with delegation) we keep him as the owner
 * rather than borrowing anyone else's identity.
 */
async function resolveKeyOwner(
	env: CloudflareEnv,
	admin: Pick<SessionUser, "id" | "role">,
	boxes: Array<{ id: string; ownerUserId: string }>,
): Promise<{ userId: string } | { error: string; status: number }> {
	const db = getDb(env);
	const owners = new Set<string>();
	for (const box of boxes) {
		const access = await getMailboxAccessLevel(db, admin, box.id);
		owners.add(access?.canRead ? admin.id : box.ownerUserId);
	}
	if (owners.size > 1) {
		return { error: "Mailboxes belong to different accounts; issue one key per account", status: 400 };
	}
	const userId = owners.values().next().value ?? admin.id;
	if (!userId) return { error: "Mailbox not found", status: 404 };
	return { userId };
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const db = getDb(env);
	// Keys issued on behalf of a child account belong to that account (see
	// `resolveKeyOwner`), so listing only `auth.userId`'s keys would hide them from
	// the admin who minted them — and the admin is the one who has to revoke them.
	const rows = await db
		.select({
			id: apiKeys.id,
			name: apiKeys.name,
			prefix: apiKeys.prefix,
			scopes: apiKeys.scopes,
			ownerUserId: apiKeys.userId,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.innerJoin(users, eq(apiKeys.userId, users.id))
		.where(or(eq(apiKeys.userId, auth.userId), eq(users.createdByUserId, auth.userId)));
	const mailKeys = rows.filter((row) => isMailKey(parseScopes(row.scopes)));
	const keyIds = mailKeys.map((row) => row.id);
	const allowed = keyIds.length ? await db.select().from(mcpKeyMailboxes).where(inArray(mcpKeyMailboxes.keyId, keyIds)) : [];
	return NextResponse.json({
		mailKeys: mailKeys.map((row) => ({
			...row,
			scopes: parseScopes(row.scopes),
			mailboxIds: allowed.filter((item) => item.keyId === row.id).map((item) => item.mailboxId),
		})),
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const parsed = createMailKeySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const mailboxIds = [...new Set(parsed.data.mailboxIds)];
	const boxes = await accessibleMailboxes(env, auth.userId, mailboxIds);
	if (boxes.length !== mailboxIds.length) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	const scopes = [...new Set(parsed.data.scopes ?? ["read"])];
	const name = parsed.data.name ?? `${boxes[0].localPart} mail key`;
	const db = getDb(env);
	const admin = (await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, auth.userId)).limit(1))[0];
	if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const owner = await resolveKeyOwner(env, admin, boxes);
	if ("error" in owner) return NextResponse.json({ error: owner.error }, { status: owner.status });
	const { fullKey, prefix, hash } = generateApiKey();
	const id = newId("key");
	await db.insert(apiKeys).values({
		id,
		userId: owner.userId,
		name,
		prefix,
		keyHash: hash,
		scopes: scopesToJson(scopes),
		mailboxScopeEnabled: true,
	});
	await db.insert(mcpKeyMailboxes).values(mailboxIds.map((mailboxId) => ({ keyId: id, mailboxId })));

	// The secret is returned exactly once, the same way the dashboard does it.
	return NextResponse.json(
		{
			id,
			name,
			prefix,
			key: fullKey,
			scopes,
			mailboxIds,
			ownerUserId: owner.userId,
			mailboxes: boxes.map((box) => ({ id: box.id, address: `${box.localPart}@${box.hostname}` })),
		},
		{ status: 201 },
	);
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const auth = await authenticateAdminApiKey(env, request, "mailboxes");
	if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	const id = new URL(request.url).searchParams.get("id");
	if (!id) return NextResponse.json({ error: "Key required" }, { status: 400 });
	const db = getDb(env);
	const [row] = await db
		.select({ id: apiKeys.id, scopes: apiKeys.scopes })
		.from(apiKeys)
		.innerJoin(users, eq(apiKeys.userId, users.id))
		.where(and(eq(apiKeys.id, id), or(eq(apiKeys.userId, auth.userId), eq(users.createdByUserId, auth.userId))))
		.limit(1);
	if (!row) return NextResponse.json({ error: "Key not found" }, { status: 404 });
	// Refuse to revoke an admin key from here: this route is about mail access, and
	// an admin key can manage domains.
	const scopes = parseScopes(row.scopes);
	if (!isMailKey(scopes)) return NextResponse.json({ error: "Not a mail key" }, { status: 403 });
	await db.delete(apiKeys).where(eq(apiKeys.id, id));
	return NextResponse.json({ ok: true });
}
