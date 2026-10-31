import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getSendStatus } from "@/lib/payments/entitlement";
import { listOrders } from "@/lib/payments/orders";

/**
 * What this account may do about sending, and what it already bought.
 *
 * One request for the whole settings section: the entitlement, the provider in
 * use, the price of a month, and recent orders. The page needs all of it at once
 * and none of it is worth its own round trip.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const orders = await listOrders(env, auth.user.id, 5);
	const openOrderId = orders.find((order) => order.status === "pending")?.id ?? null;
	const status = await getSendStatus(env, { userId: auth.user.id, openOrderId });
	return Response.json({ ...status, orders }, { headers: { "Cache-Control": "no-store" } });
}
