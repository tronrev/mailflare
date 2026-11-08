import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { describeDatabaseError } from "@/lib/database-errors";
import { getSendStatus, type SendStatusView } from "@/lib/payments/entitlement";

/**
 * The one bit the composer needs before it opens: may this account send, and if
 * not, what is on offer.
 *
 * Separate from `/api/billing` because that one also lists orders and walks this
 * account's mailboxes, and the composer asks on every page load. Nothing here is
 * secret and nothing here is cached: the answer changes the moment a key is saved
 * or a payment lands.
 */
export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;

	let status: SendStatusView;
	try {
		status = await getSendStatus(env, { userId: auth.user.id });
	} catch (error) {
		const detail = describeDatabaseError(error);
		console.error("[billing] send access failed:", detail);
		return Response.json(
			{ error: "Could not load sending settings", ...(auth.user.role === "admin" ? { detail } : {}) },
			{ status: 500, headers: { "Cache-Control": "no-store" } },
		);
	}

	return Response.json(
		{
			allowed: status.allowed,
			reason: status.reason,
			admin: status.admin,
			/** The free allowance, so the composer can say "2 left" before it refuses. */
			free: status.free,
			own: status.own,
			buyingOffered: status.buyingOffered,
			canStoreCredentials: status.canStoreCredentials,
			pricePerMonth: status.pricePerMonth,
			months: status.months,
			address: status.address,
			paidUntil: status.paidUntil,
			paidDaysLeft: status.paidDaysLeft,
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
