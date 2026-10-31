/**
 * What a subscription costs, and how a payment on the chain is tied back to the
 * order it pays for.
 *
 * USDT has no "reference" field, so a transfer is just an amount and a time. Two
 * people buying one month would otherwise send the identical 1.000 USDT and
 * nothing could tell the two payments apart. The fix is a checksum hidden in the
 * digits after the decimal point: the order costs `months.kkk`, where `kkk` comes
 * from the buyer's own row, so a payment is identified by (amount, time window)
 * without anyone having to type a memo.
 *
 * Kept free of imports: the Worker, the page that shows the amount, and the tests
 * all need exactly these numbers.
 */

export const USDT_DECIMALS = 6;
/** One USDT in the smallest unit the chain speaks. */
export const USDT_MICRO = 10 ** USDT_DECIMALS;

export const ORDER_MIN_MONTHS = 1;
export const ORDER_MAX_MONTHS = 12;

/** How long an unpaid order holds its amount before it stops being matchable. */
export const ORDER_TTL_MINUTES = 30;

/** USDT-TRC20. Any other token sent to the address is not money for an order. */
export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

export type MonthCount = number;

/**
 * The three digits that make an amount unique to one account.
 *
 * `users.created_at` is a whole second, so its last three digits are effectively
 * a number drawn when the account was made. Two accounts created in the same
 * second share a checksum — that is fine, because the amount alone is never the
 * only evidence: the matching also requires the payment to land inside that
 * order's 30-minute window, and one transaction can only pay one order.
 */
export function amountChecksum(accountCreatedAt: Date | number): number {
	const seconds = accountCreatedAt instanceof Date ? Math.floor(accountCreatedAt.getTime() / 1000) : Math.floor(accountCreatedAt);
	return Math.abs(seconds) % 1000;
}

export function isValidMonthCount(months: unknown): months is MonthCount {
	return typeof months === "number" && Number.isInteger(months) && months >= ORDER_MIN_MONTHS && months <= ORDER_MAX_MONTHS;
}

/**
 * The exact amount to ask for, in micro-USDT: `months` whole USDT plus the
 * checksum in thousandths. Integer maths only — floating point would turn
 * 3.402 into 3.4019999999999997 and no payment would ever match.
 */
export function orderAmountMicro(months: MonthCount, accountCreatedAt: Date | number): number {
	if (!isValidMonthCount(months)) throw new RangeError(`months must be an integer in ${ORDER_MIN_MONTHS}..${ORDER_MAX_MONTHS}`);
	return months * USDT_MICRO + amountChecksum(accountCreatedAt) * 1000;
}

/** "3.402" — what the payer types into their wallet or exchange withdrawal form. */
export function formatAmount(micro: number): string {
	const whole = Math.trunc(micro / USDT_MICRO);
	const fraction = Math.abs(micro % USDT_MICRO);
	const digits = String(fraction).padStart(USDT_DECIMALS, "0").replace(/0+$/, "");
	return digits ? `${whole}.${digits}` : String(whole);
}

/**
 * Reads an order amount back. Exists so a payer (and the tests) can confirm the
 * number on screen is the number the chain will see; it refuses anything that is
 * not an exact micro-USDT amount, since a rounded payment never matches.
 */
export function parseAmount(text: string): number | null {
	const trimmed = text.trim();
	const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(trimmed);
	if (!match) return null;
	const whole = Number(match[1]);
	const fraction = Number((match[2] ?? "").padEnd(USDT_DECIMALS, "0") || 0);
	return whole * USDT_MICRO + fraction;
}

export type PaymentCandidate = { txId: string; amountMicro: number; timestampMs: number };

export type OrderTerms = { months: MonthCount; amountMicro: number; createdAtMs: number; expiresAtMs: number };
/**
 * Whether one on-chain transfer pays for this order: same amount, inside the
 * window, and only once. The window is checked against the transfer's own
 * timestamp rather than when the poller happened to look, so a payment made at
 * minute 29 still counts when it is noticed at minute 31 — the alternative is
 * charging people for mail that arrived while the worker was asleep.
 */
export function transferPaysOrder(transfer: PaymentCandidate, order: OrderTerms): boolean {
	if (transfer.amountMicro !== order.amountMicro) return false;
	return transfer.timestampMs >= order.createdAtMs && transfer.timestampMs <= order.expiresAtMs;
}

/**
 * How long a paid month lasts. A fixed 30 days rather than a calendar month: a
 * subscription that pauses or expires in the middle of a billing month would
 * otherwise cost different amounts for the same price.
 */
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a payment is still matched after its order's window has closed.
 *
 * The poller runs every five minutes and a payment made at minute 29 must not be
 * lost because nobody looked until minute 34, so an order stays matchable for a
 * while after it has stopped being payable.
 */
export const MATCH_GRACE_MS = 15 * 60 * 1000;

/**
 * When sending stays paid up to. Buying time while still paid extends the
 * existing expiry instead of restarting it, so a subscriber who renews a week
 * early keeps the week they paid for.
 */
export function paidUntilAfter(current: Date | number | null, months: MonthCount, now: Date | number): Date {
	const currentMs = current instanceof Date ? current.getTime() : current;
	const nowMs = now instanceof Date ? now.getTime() : now;
	const base = typeof currentMs === "number" && Number.isFinite(currentMs) && currentMs > nowMs ? currentMs : nowMs;
	return new Date(base + months * MONTH_MS);
}

/** Whether sending is paid for at `now`. An expired timestamp is not a boolean. */
export function isPaidActive(paidUntil: Date | number | null | undefined, now: Date | number): boolean {
	if (!paidUntil) return false;
	const until = paidUntil instanceof Date ? paidUntil.getTime() : paidUntil;
	const nowMs = now instanceof Date ? now.getTime() : now;
	return Number.isFinite(until) && until > nowMs;
}

/** Whole days left, rounded up, for the "12 days left" line. 0 when not paid. */
export function paidDaysLeft(paidUntil: Date | number | null | undefined, now: Date | number): number {
	if (!paidUntil) return 0;
	const until = paidUntil instanceof Date ? paidUntil.getTime() : paidUntil;
	const nowMs = now instanceof Date ? now.getTime() : now;
	if (!Number.isFinite(until) || until <= nowMs) return 0;
	return Math.ceil((until - nowMs) / (24 * 60 * 60 * 1000));
}
