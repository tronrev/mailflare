import assert from "node:assert/strict";
import test from "node:test";

const amount = await import("../src/lib/payments/usdt-amount.ts");
const tron = await import("../src/lib/payments/trongrid.ts");

/**
 * USDT has no memo field: a payment is an amount and a timestamp, so the amount
 * itself has to carry the order's identity. These pin the arithmetic, because a
 * rounding slip here means money arrives and no order ever matches it.
 */

const createdAt = new Date("2026-10-30T12:00:00Z"); // → 1761825600, checksum 600

test("both modules name the same USDT contract", () => {
	// trongrid.ts repeats the constant to stay import-free; this is the guard
	// that keeps the copy honest.
	assert.equal(tron.USDT_TRC20_CONTRACT, amount.USDT_TRC20_CONTRACT);
});

test("the checksum is the buyer's own three digits", () => {
	assert.equal(amount.amountChecksum(createdAt), 600);
	assert.equal(amount.amountChecksum(new Date("2026-10-30T12:00:01Z")), 601);
	assert.equal(amount.amountChecksum(0), 0);
});

test("an order costs its months plus the checksum in thousandths", () => {
	assert.equal(amount.orderAmountMicro(1, createdAt), 1_600_000);
	assert.equal(amount.formatAmount(1_600_000), "1.6");
	assert.equal(amount.orderAmountMicro(12, createdAt), 12_600_000);
	// Two buyers created a millisecond apart must not ask for the same amount.
	const other = new Date(createdAt.getTime() + 1000);
	assert.notEqual(amount.orderAmountMicro(1, createdAt), amount.orderAmountMicro(1, other));
});

test("integer maths only: no floating point drift in the amount", () => {
	for (let months = 1; months <= 12; months++) {
		const micro = amount.orderAmountMicro(months, new Date("2026-10-30T12:00:07Z"));
		assert.equal(micro % 1000, 0, "the smallest unit must be a clean thousandth (0.001 USDT)");
		assert.equal(amount.parseAmount(amount.formatAmount(micro)), micro);
	}
});

test("months outside 1..12 are refused", () => {
	for (const bad of [0, 13, -1, 1.5, NaN]) {
		assert.equal(amount.isValidMonthCount(bad), false, String(bad));
		assert.throws(() => amount.orderAmountMicro(bad, createdAt));
	}
	for (let months = 1; months <= 12; months++) assert.equal(amount.isValidMonthCount(months), true);
});

test("amounts read back exactly, and wrong shapes are refused", () => {
	assert.equal(amount.parseAmount("1.600"), 1_600_000);
	assert.equal(amount.parseAmount(" 12.001 "), 12_001_000);
	assert.equal(amount.parseAmount("3"), 3_000_000);
	for (const bad of ["", "1.6000001", "abc", "1,6", "-1", "1.6 USDT"]) {
		assert.equal(amount.parseAmount(bad), null, bad);
	}
});

test("a transfer pays one order: right amount inside its window", () => {
	const order = { months: 1, amountMicro: 1_600_000, createdAtMs: 1000, expiresAtMs: 1000 + 30 * 60 * 1000 };
	const at = (amountMicro, timestampMs) => ({ txId: "t", amountMicro, timestampMs });
	assert.equal(amount.transferPaysOrder(at(1_600_000, 2000), order), true);
	// Noticed late, paid on time: the worker being asleep must not cost the payer.
	assert.equal(amount.transferPaysOrder(at(1_600_000, order.expiresAtMs - 1), order), true);
	assert.equal(amount.transferPaysOrder(at(1_600_000, order.expiresAtMs + 1), order), false);
	assert.equal(amount.transferPaysOrder(at(1_600_000, 999), order), false);
	// Somebody else's 1.6 USDT is not this order's 1.6 USDT.
	assert.equal(amount.transferPaysOrder(at(1_601_000, 2000), order), false);
	assert.equal(amount.transferPaysOrder(at(1_000_000, 2000), order), false);
});

test("TronGrid parsing keeps only confirmed USDT transfers to the address", () => {
	const parsed = tron.parseTrc20Transfers({
		success: true,
		data: [
			{
				transaction_id: "a".repeat(64),
				from: "TFROM",
				to: "TRonreRqhvN7MAPApLqTnhV1GS9F3RaE8N",
				value: "1600000",
				block_timestamp: 1761825600000,
				type: "Transfer",
				token_info: { address: amount.USDT_TRC20_CONTRACT, decimals: 6, symbol: "USDT" },
			},
			// Right shape, wrong token: someone paid in a lookalike contract.
			{
				transaction_id: "b".repeat(64),
				to: "TRonreRqhvN7MAPApLqTnhV1GS9F3RaE8N",
				value: "999000000",
				block_timestamp: 1761825600000,
				type: "Transfer",
				token_info: { address: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", decimals: 6 },
			},
			// Not a transfer at all.
			{ transaction_id: "c".repeat(64), type: "Approval", token_info: { address: amount.USDT_TRC20_CONTRACT } },
		],
	});
	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], {
		txId: "a".repeat(64),
		from: "TFROM",
		to: "TRonreRqhvN7MAPApLqTnhV1GS9F3RaE8N",
		amountMicro: 1_600_000,
		timestampMs: 1761825600000,
		contract: amount.USDT_TRC20_CONTRACT,
	});
});

test("unreadable rows are dropped, not guessed at", () => {
	assert.deepEqual(tron.parseTrc20Transfers(null), []);
	assert.deepEqual(tron.parseTrc20Transfers({}), []);
	assert.deepEqual(tron.parseTrc20Transfers({ data: "nope" }), []);
	assert.deepEqual(
		tron.parseTrc20Transfers({
			data: [
				// Amount that is not an integer count of micro-USDT.
				{ transaction_id: "d", to: "T", value: "1.6", block_timestamp: 1, type: "Transfer", token_info: { address: amount.USDT_TRC20_CONTRACT } },
				// No timestamp: cannot be placed in a window.
				{ transaction_id: "e", to: "T", value: "1000000", type: "Transfer", token_info: { address: amount.USDT_TRC20_CONTRACT } },
			],
		}),
		[],
	);
});

test("the URL asks for confirmed incoming USDT only", () => {
	const url = new URL(tron.transfersUrl("TRonreRqhvN7MAPApLqTnhV1GS9F3RaE8N", { sinceMs: 1761825600000 }));
	assert.ok(url.pathname.startsWith("/v1/accounts/TRonreRqhvN7MAPApLqTnhV1GS9F3RaE8N/transactions/trc20"));
	assert.equal(url.searchParams.get("only_to"), "true");
	assert.equal(url.searchParams.get("only_confirmed"), "true");
	assert.equal(url.searchParams.get("contract_address"), amount.USDT_TRC20_CONTRACT);
	assert.equal(url.searchParams.get("min_timestamp"), "1761825600000");
});

test("the API key is only sent when one is configured", async () => {
	const seen = [];
	const fetchImpl = async (_url, init) => {
		seen.push(init?.headers ?? {});
		return { ok: true, status: 200, json: async () => ({ data: [] }) };
	};
	await tron.fetchUsdtTransfers("T", { fetchImpl });
	await tron.fetchUsdtTransfers("T", { fetchImpl, apiKey: "  k  " });
	assert.equal("TRON-PRO-API-KEY" in seen[0], false);
	assert.equal(seen[1]["TRON-PRO-API-KEY"], "k");
});
