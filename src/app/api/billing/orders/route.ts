import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getSystemProvider } from "@/lib/payments/entitlement";
import { createOrder, listOrders } from "@/lib/payments/orders";

/**
 * Buying sending time.
 *
 * `months` is the only input: the price per month is fixed, and the exact amount
 * to send is derived from the account so that no two payers are asked for the
 * same figure. Nothing is charged from here — the order exists until a transfer
 * matching it is seen on the chain (lib/payments/orders.ts).
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	return Response.json({ orders: await listOrders(env, auth.user.id) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });

	// Selling time on a deployment that cannot send would take money for nothing.
	if (!(await getSystemProvider(env))) {
		return Response.json(
			{ error: "This server has no sending provider configured, so sending cannot be bought here yet." },
			{ status: 503 },
		);
	}

	const body = (await request.json().catch(() => null)) as { months?: unknown } | null;
	const outcome = await createOrder(env, auth.user.id, body?.months);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ order: outcome.order }, { headers: { "Cache-Control": "no-store" } });
}
