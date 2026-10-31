import { and, desc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { users, usdtOrders } from "@/db/schema";
import { newId } from "@/lib/ids";
import {
	MATCH_GRACE_MS,
	ORDER_TTL_MINUTES,
	formatAmount,
	isValidMonthCount,
	orderAmountMicro,
	paidUntilAfter,
	transferPaysOrder,
} from "@/lib/payments/usdt-amount";
import { fetchUsdtTransfers, type UsdtTransfer } from "@/lib/payments/trongrid";

/**
 * Buying sending time with USDT-TRC20.
 *
 * There is no payment provider in the middle and therefore no webhook: an order
 * is a row with an amount nobody else is being asked for, and a scheduled sweep
 * compares what the chain says arrived against the orders that are still open.
 * Everything here is idempotent, because the sweep runs on a five-minute cron, on
 * a page refresh and after a crash — and it must agree with itself every time.
 */

/** Where the money goes. Set `USDT_PAYMENT_ADDRESS` to receive somewhere else. */
export const DEFAULT_USDT_ADDRESS = "TRonreRqhvN7MAPApLqTnhV1GS9F3RaE8N";

export function paymentAddress(env: CloudflareEnv): string {
	return env.USDT_PAYMENT_ADDRESS?.trim() || DEFAULT_USDT_ADDRESS;
}

export type OrderView = {
	id: string;
	months: number;
	amountMicro: number;
	/** "1.842" — the exact figure to send, checksum included. */
	amount: string;
	address: string;
	status: "pending" | "paid" | "expired";
	txId: string | null;
	createdAt: string;
	expiresAt: string;
	paidAt: string | null;
	paidUntil: string | null;
};

function toView(row: typeof usdtOrders.$inferSelect): OrderView {
	return {
		id: row.id,
		months: row.months,
		amountMicro: row.amountMicro,
		amount: formatAmount(row.amountMicro),
		address: row.address,
		status: row.status,
		txId: row.txId,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		paidAt: row.paidAt?.toISOString() ?? null,
		paidUntil: row.paidUntil?.toISOString() ?? null,
	};
}

export type CreateOrderOutcome =
	| { ok: true; order: OrderView }
	| { ok: false; status: number; error: string };

/**
 * Opens an order for `months` of sending, priced with this account's checksum.
 *
 * Only one order per account is allowed to be open at a time. Two live amounts
 * from the same account would be indistinguishable on the chain — the checksum
 * identifies the account, not the attempts — so a second order cancels the first
 * rather than leaving the payer to guess which number is still current.
 */
export async function createOrder(env: CloudflareEnv, userId: string, months: unknown): Promise<CreateOrderOutcome> {
	if (!isValidMonthCount(months)) {
		return { ok: false, status: 400, error: "Choose between 1 and 12 months" };
	}
	const db = getDb(env);
	const [user] = await db
		.select({ id: users.id, createdAt: users.createdAt, sendPaidUntil: users.sendPaidUntil })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) return { ok: false, status: 404, error: "Account not found" };

	const now = new Date();
	await db
		.update(usdtOrders)
		.set({ status: "expired" })
		.where(and(eq(usdtOrders.userId, userId), eq(usdtOrders.status, "pending")));

	const row: typeof usdtOrders.$inferInsert = {
		id: newId("ord"),
		userId,
		months,
		amountMicro: orderAmountMicro(months, user.createdAt),
		address: paymentAddress(env),
		status: "pending",
		createdAt: now,
		expiresAt: new Date(now.getTime() + ORDER_TTL_MINUTES * 60 * 1000),
	};
	await db.insert(usdtOrders).values(row);
	return {
		ok: true,
		order: {
			id: row.id,
			months: row.months,
			amountMicro: row.amountMicro,
			amount: formatAmount(row.amountMicro),
			address: row.address,
			status: "pending",
			txId: null,
			createdAt: row.createdAt.toISOString(),
			expiresAt: row.expiresAt.toISOString(),
			paidAt: null,
			paidUntil: null,
		},
	};
}

export async function listOrders(env: CloudflareEnv, userId: string, limit = 10): Promise<OrderView[]> {
	const rows = await getDb(env)
		.select()
		.from(usdtOrders)
		.where(eq(usdtOrders.userId, userId))
		.orderBy(desc(usdtOrders.createdAt))
		.limit(limit);
	return rows.map(toView);
}

export async function getOrder(env: CloudflareEnv, userId: string, orderId: string): Promise<OrderView | null> {
	const [row] = await getDb(env)
		.select()
		.from(usdtOrders)
		.where(and(eq(usdtOrders.id, orderId), eq(usdtOrders.userId, userId)))
		.limit(1);
	return row ? toView(row) : null;
}

export type SweepResult = {
	expired: number;
	paid: number;
	/** Transfers seen that matched no open order: a payment sent after its window, or a wrong amount. */
	unmatched: number;
	/**
	 * Transfers that fitted more than one open order. Two accounts can be asked for
	 * the same amount (the checksum repeats every 1000 seconds), and crediting
	 * either one would take money that may belong to the other, so neither is
	 * credited and both are left to be sorted out by a person.
	 */
	ambiguous: number;
	/** Set when TronGrid could not be read this round; orders stay pending. */
	error?: string;
};

/**
 * Marks paid orders and extends the buyer's sending time.
 *
 * The order row is claimed before the credit is applied, so two overlapping
 * sweeps (cron plus a page refresh) cannot both credit the same payment: the
 * loser's update matches no row and it moves on. `usdt_orders.tx_id` is unique as
 * a second lock, because the first one only holds inside one database.
 */
export async function sweepUsdtOrders(env: CloudflareEnv, now: Date = new Date()): Promise<SweepResult> {
	const db = getDb(env);
	const result: SweepResult = { expired: 0, paid: 0, unmatched: 0, ambiguous: 0 };

	const expired = await db
		.update(usdtOrders)
		.set({ status: "expired" })
		.where(
			and(
				eq(usdtOrders.status, "pending"),
				lt(usdtOrders.expiresAt, new Date(now.getTime() - MATCH_GRACE_MS)),
			),
		)
		.returning({ id: usdtOrders.id });
	result.expired = expired.length;

	// Anything still matchable: open now, or open recently enough that a payment
	// made before the window closed may not have been noticed yet.
	const open = await db
		.select()
		.from(usdtOrders)
		.where(
			and(
				eq(usdtOrders.status, "pending"),
				gte(usdtOrders.expiresAt, new Date(now.getTime() - MATCH_GRACE_MS)),
			),
		);
	if (!open.length) return result;

	const address = open[0].address;
	const sinceMs = Math.min(...open.map((order) => order.createdAt.getTime())) - 60_000;
	let transfers: UsdtTransfer[];
	try {
		transfers = await fetchUsdtTransfers(address, {
			sinceMs,
			apiKey: env.TRONGRID_API_KEY,
			fetchImpl: fetch as unknown as Parameters<typeof fetchUsdtTransfers>[1]["fetchImpl"],
		});
	} catch (error) {
		result.error = error instanceof Error ? error.message : "TronGrid could not be read";
		console.warn("USDT sweep could not read TronGrid", result.error);
		return result;
	}

	const claimed = new Set<string>();
	for (const transfer of transfers) {
		const fits = open.filter(
			(candidate) =>
				!claimed.has(candidate.id) &&
				candidate.address === transfer.to &&
				transferPaysOrder(
					{ txId: transfer.txId, amountMicro: transfer.amountMicro, timestampMs: transfer.timestampMs },
					{
						months: candidate.months,
						amountMicro: candidate.amountMicro,
						createdAtMs: candidate.createdAt.getTime(),
						expiresAtMs: candidate.expiresAt.getTime() + MATCH_GRACE_MS,
					},
				),
		);
		if (fits.length > 1) {
			console.warn("USDT transfer fits several orders; leaving it unclaimed", {
				txId: transfer.txId,
				orders: fits.map((candidate) => candidate.id),
			});
			result.ambiguous += 1;
			continue;
		}
		const [order] = fits;
		if (!order) {
			result.unmatched += 1;
			continue;
		}
		claimed.add(order.id);
		const paidAt = new Date(transfer.timestampMs);
		const [user] = await db
			.select({ sendPaidUntil: users.sendPaidUntil })
			.from(users)
			.where(eq(users.id, order.userId))
			.limit(1);
		const paidUntil = paidUntilAfter(user?.sendPaidUntil ?? null, order.months, now);
		const updated = await db
			.update(usdtOrders)
			.set({ status: "paid", txId: transfer.txId, paidAt, paidUntil })
			.where(and(eq(usdtOrders.id, order.id), eq(usdtOrders.status, "pending")))
			.returning({ id: usdtOrders.id });
		if (!updated.length) continue;
		await db.update(users).set({ sendPaidUntil: paidUntil }).where(eq(users.id, order.userId));
		result.paid += 1;
	}
	return result;
}

/**
 * Runs the sweep at most once per interval per isolate.
 *
 * The order page polls, and every poll would otherwise be a TronGrid request:
 * one person watching their payment would spend the whole free quota. The cron
 * still runs on its own schedule; this only stops the page from doing the work.
 */
let lastOnDemandSweep = 0;
export async function sweepUsdtOrdersOnDemand(
	env: CloudflareEnv,
	minimumIntervalMs = 20_000,
	now: Date = new Date(),
): Promise<SweepResult | null> {
	const stamp = Date.now();
	if (stamp - lastOnDemandSweep < minimumIntervalMs) return null;
	lastOnDemandSweep = stamp;
	return sweepUsdtOrders(env, now);
}
