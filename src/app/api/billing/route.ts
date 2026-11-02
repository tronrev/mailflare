import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getSendStatus, type SendStatusView } from "@/lib/payments/entitlement";
import { listOrders, type OrderView } from "@/lib/payments/orders";

/**
 * What this account may do about sending, and what it already bought.
 *
 * One request for the whole settings section: the entitlement, the provider in
 * use, the price of a month, and recent orders. The page needs all of it at once
 * and none of it is worth its own round trip.
 *
 * The orders are read first but separately: they are a history, not the answer to
 * "may I send", so a database that cannot answer for them yet (an unapplied
 * migration, say) must not blank the part that can. What went wrong is logged,
 * and where the reader is the administrator of this deployment it is returned
 * too — "Could not load sending settings" with no reason is not something
 * anybody can act on.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const isAdmin = auth.user.role === "admin";
	let orders: OrderView[] = [];
	let ordersError: string | null = null;
	try {
		orders = await listOrders(env, auth.user.id, 5);
	} catch (error) {
		ordersError = error instanceof Error ? error.message : String(error);
		console.error("[billing] orders unavailable:", ordersError);
	}

	const openOrderId = orders.find((order) => order.status === "pending")?.id ?? null;
	let status: SendStatusView;
	try {
		status = await getSendStatus(env, { userId: auth.user.id, openOrderId });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error("[billing] sending status failed:", detail);
		return Response.json(
			{ error: "Could not load sending settings", ...(isAdmin ? { detail } : {}) },
			{ status: 500, headers: { "Cache-Control": "no-store" } },
		);
	}

	return Response.json(
		{ ...status, orders, ...(ordersError && isAdmin ? { ordersError } : {}) },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
