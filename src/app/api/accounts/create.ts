import { and, eq, inArray } from "drizzle-orm";
import { isUniqueConstraintError } from "@/lib/database-errors";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { ensureBookingUsername } from "@/lib/booking/username";
import { rollbackEmailRoutingRuleChanges } from "@/lib/cloudflare-api";
import type { CfEmailRoutingRuleChange } from "@/lib/cloudflare-api.types";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import { getAccountSeatError } from "@/lib/licenses/seats";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import type { CreateUserAccountInput } from "./types";
import { accountListItemFromUser, getDomainForAdmin } from "./utils";

/** Shared by dashboard and admin API/MCP account creation. */
export async function createAccountResponse(env: CloudflareEnv, adminUserId: string, input: CreateUserAccountInput) {
	const seatError = await getAccountSeatError(env);
	if (seatError) return NextResponse.json({ error: seatError }, { status: 403 });
	const db = getDb(env);
	const primaryDomain = await getDomainForAdmin(db, adminUserId, input.domainId);
	if (!primaryDomain) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
	const username = input.username.toLowerCase().trim();
	const email = `${username}@${primaryDomain.hostname}`;
	const requested = [{ domainId: primaryDomain.id, localPart: username }, ...input.aliases];
	const ownedDomains = await db.select().from(domains).where(eq(domains.userId, adminUserId));
	const byId = new Map(ownedDomains.map((domain) => [domain.id, domain]));
	const seen = new Set<string>();
	for (const [index, address] of requested.entries()) {
		const domain = byId.get(address.domainId);
		if (!domain || (index > 0 && domain.status !== "active")) {
			return NextResponse.json({ error: "Choose an active alias domain owned by this admin account" }, { status: 400 });
		}
		const localPart = normalizeRecipientLocalPart(address.localPart);
		if (!localPart) return NextResponse.json({ error: "Enter a valid address username" }, { status: 400 });
		const key = `${localPart}@${domain.id}`;
		if (seen.has(key)) {
			return NextResponse.json({ error: "Each alias must be distinct from the primary address and other aliases" }, { status: 400 });
		}
		seen.add(key);
	}
	const [registered] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
	if (registered) return NextResponse.json({ error: "Email already registered" }, { status: 409 });
	// A subquery avoids one bound parameter per selected domain.
	const ownedDomainIds = db.select({ id: domains.id }).from(domains).where(eq(domains.userId, adminUserId));
	const [existingMailboxes, existingAliases] = await Promise.all([
		db.select({ domainId: mailboxes.domainId, localPart: mailboxes.localPart }).from(mailboxes).where(inArray(mailboxes.domainId, ownedDomainIds)),
		db.select({ domainId: mailboxAliases.domainId, localPart: mailboxAliases.localPart }).from(mailboxAliases).where(inArray(mailboxAliases.domainId, ownedDomainIds)),
	]);
	const addressKey = (address: { domainId: string; localPart: string }) =>
		`${normalizeRecipientLocalPart(address.localPart)}@${address.domainId}`;
	const primaryKey = `${username}@${primaryDomain.id}`;
	// `seen` holds the primary address plus every alias of this request.
	const aliasConflict = existingAliases.some((address) => seen.has(addressKey(address)));
	const mailboxConflicts = existingMailboxes.filter((address) => seen.has(addressKey(address)));
	// Only the primary address of this request can be adopted, and only on its own.
	const adoptable = input.adoptMailbox
		&& mailboxConflicts.length === 1
		&& addressKey(mailboxConflicts[0]) === primaryKey;
	if (aliasConflict || (mailboxConflicts.length > 0 && !adoptable)) {
		return NextResponse.json({ error: "An email address is already assigned to a mailbox or alias" }, { status: 409 });
	}

	// Adoption exists for one real situation: the mailbox was created first (a
	// provisioning script only needed an inbox at the time) and the login account
	// comes later. The address already receives mail, so the account takes the
	// mailbox over instead of failing — but only when this admin already owns it
	// and it is a personal mailbox. Anything else stays a 409.
	let adoptedMailboxId = "";
	if (adoptable) {
		const [candidate] = await db
			.select()
			.from(mailboxes)
			.where(and(eq(mailboxes.domainId, primaryDomain.id), eq(mailboxes.localPart, username)))
			.limit(1);
		if (!candidate || candidate.userId !== adminUserId || candidate.type !== "personal") {
			return NextResponse.json({ error: "An email address is already assigned to a mailbox or alias" }, { status: 409 });
		}
		adoptedMailboxId = candidate.id;
	}

	const userId = newId("usr");
	const mailboxId = adoptedMailboxId || newId("mbx");
	const mailbox = { id: mailboxId, userId, domainId: primaryDomain.id, localPart: username, displayName: username, useAllDomains: input.useAllDomains };
	const changes: CfEmailRoutingRuleChange[] = [];
	let inserted = false;
	try {
		const accountInsert = db.insert(users).values({
			id: userId, email, passwordHash: hashPassword(input.password), name: username,
			role: input.role, createdByUserId: adminUserId,
		}).returning();
		// 接管既有信箱时只换属主与显示名：地址与历史邮件都留在原地，
		// 但绝不能再插一条同地址的信箱（唯一索引会直接撞上）。
		const mailboxWrite = adoptedMailboxId
			? db.update(mailboxes).set({ userId, displayName: username }).where(eq(mailboxes.id, adoptedMailboxId))
			: db.insert(mailboxes).values(mailbox);
		// Five bound columns per alias: 20 rows fit D1's 100-parameter limit.
		const aliasInserts = Array.from({ length: Math.ceil(input.aliases.length / 20) }, (_, index) =>
			db.insert(mailboxAliases).values(input.aliases.slice(index * 20, (index + 1) * 20).map((alias) => ({
				id: newId("als"), mailboxId, domainId: alias.domainId, localPart: alias.localPart,
			}))),
		);
		// D1 batches are atomic: aliases and their owner either all exist or none do.
		const [accounts] = await db.batch([accountInsert, mailboxWrite, ...aliasInserts]);
		inserted = true;
		await ensureBookingUsername(env, userId, email);
		await ensureMailboxDomainRouting(env, db, mailbox, changes);
		return NextResponse.json({ account: accountListItemFromUser(accounts[0]) }, { status: 201 });
	} catch (error) {
		let cleanupFailed = false;
		// 接管失败时**先**把信箱还给原主、再删账号：`mailboxes.user_id` 是
		// ON DELETE CASCADE，顺序反了会把这只信箱连同历史邮件一起删掉。
		if (inserted && adoptedMailboxId) {
			try {
				await db.update(mailboxes).set({ userId: adminUserId }).where(eq(mailboxes.id, adoptedMailboxId));
			} catch {
				cleanupFailed = true;
			}
		}
		if (inserted) {
			try {
				await db.delete(users).where(eq(users.id, userId));
			} catch {
				cleanupFailed = true;
			}
		}
		try {
			await rollbackEmailRoutingRuleChanges(env, changes);
		} catch {
			cleanupFailed = true;
		}
		if (cleanupFailed) {
			return NextResponse.json({ error: "Account creation failed and cleanup could not finish. Check the account and Cloudflare routing before retrying." }, { status: 502 });
		}
		if (isUniqueConstraintError(error)) {
			return NextResponse.json({ error: "An email address is already assigned" }, { status: 409 });
		}
		return NextResponse.json({ error: "Failed to create account mailbox routing. Please try again." }, { status: 502 });
	}
}
