import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getOrder, sweepUsdtOrdersOnDemand } from "@/lib/payments/orders";
import { getSendStatus } from "@/lib/payments/entitlement";

type OrderRouteParams = {
	params: Promise<{ id: string }>;
};

/**
 * The state of one order.
 *
 * Polling this is how the page knows a payment landed, and it is the only place
 * that reads the chain on demand — throttled inside `sweepUsdtOrdersOnDemand`, so
 * fifty tabs watching one payment cost one request, not fifty.
 */
export async function GET(request: Request, { params }: OrderRouteParams) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	const { id } = await params;
	const before = await getOrder(env, auth.user.id, id);
	if (!before) return NextResponse.json({ error: "Not found" }, { status: 404 });

	if (before.status === "pending") await sweepUsdtOrdersOnDemand(env).catch(() => null);
	const order = (await getOrder(env, auth.user.id, id)) ?? before;
	const status = order.status === "paid" ? await getSendStatus(env, { userId: auth.user.id }) : null;
	return NextResponse.json({ order, send: status }, { headers: { "Cache-Control": "no-store" } });
}
