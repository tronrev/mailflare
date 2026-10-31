/**
 * Reading USDT payments off TRON.
 *
 * TronGrid is the Tron Foundation's hosted index, and the free tier is enough
 * here: polling a handful of pending orders once every few minutes is a handful
 * of requests. No API key is required for that volume — set `TRONGRID_API_KEY`
 * to raise the ceiling, and the header is sent only when one exists.
 *
 * Import-free apart from the contract constant, and `fetch` is injected, so the
 * parsing can be tested against recorded responses instead of the live chain.
 */

/**
 * USDT-TRC20. Same value as `USDT_TRC20_CONTRACT` in `usdt-amount.ts`, repeated
 * here so this module needs no import and the tests can load it on its own; a
 * test asserts the two agree, so the copy cannot drift unnoticed.
 */
export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

export type UsdtTransfer = {
	txId: string;
	from: string;
	to: string;
	/** Smallest unit (6 decimals). */
	amountMicro: number;
	timestampMs: number;
	contract: string;
};

export const TRONGRID_BASE = "https://api.trongrid.io";

export function transfersUrl(address: string, options: { sinceMs?: number; limit?: number } = {}): string {
	const params = new URLSearchParams({
		only_to: "true",
		// An unconfirmed transfer can still be reverted; credits wait for a block.
		only_confirmed: "true",
		limit: String(options.limit ?? 200),
		contract_address: USDT_TRC20_CONTRACT,
	});
	if (options.sinceMs) params.set("min_timestamp", String(options.sinceMs));
	return `${TRONGRID_BASE}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`;
}

type TronGridRow = {
	transaction_id?: string;
	from?: string;
	to?: string;
	value?: string;
	block_timestamp?: number;
	type?: string;
	token_info?: { address?: string; decimals?: number | string };
};

/**
 * Turns TronGrid's response into transfers that could pay an order. Anything it
 * cannot read with certainty is dropped rather than guessed at: a payment that is
 * misread credits somebody for money that was never sent, and a missing payment
 * is a support message — only one of those is recoverable.
 */
export function parseTrc20Transfers(payload: unknown): UsdtTransfer[] {
	const rows = Array.isArray((payload as { data?: unknown })?.data) ? ((payload as { data: TronGridRow[] }).data) : [];
	const out: UsdtTransfer[] = [];
	for (const row of rows) {
		if (row?.type !== "Transfer") continue;
		const contract = row.token_info?.address;
		if (!contract || contract !== USDT_TRC20_CONTRACT) continue;
		const decimals = Number(row.token_info?.decimals ?? 6);
		const raw = row.value;
		if (!raw || !/^\d+$/.test(raw)) continue;
		let amountMicro = Number(raw);
		// TronGrid reports the smallest unit; a different decimal count would mean a
		// different token, which the contract check above already excluded.
		if (decimals !== 6) amountMicro = Math.round(Number(raw) * 10 ** (6 - decimals));
		const txId = row.transaction_id;
		const to = row.to;
		const timestampMs = row.block_timestamp;
		if (!txId || !to || typeof timestampMs !== "number" || !Number.isFinite(amountMicro)) continue;
		out.push({ txId, from: row.from ?? "", to, amountMicro, timestampMs, contract });
	}
	return out;
}

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

/** Newest incoming USDT transfers to `address`, or an empty list if TronGrid is unhappy. */
export async function fetchUsdtTransfers(
	address: string,
	options: { sinceMs?: number; apiKey?: string; fetchImpl: FetchLike; timeoutMs?: number },
): Promise<UsdtTransfer[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey?.trim()) headers["TRON-PRO-API-KEY"] = options.apiKey.trim();
	const response = await options.fetchImpl(transfersUrl(address, { sinceMs: options.sinceMs }), {
		headers,
		signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
	});
	if (!response.ok) throw new Error(`TronGrid answered ${response.status}`);
	return parseTrc20Transfers(await response.json());
}
