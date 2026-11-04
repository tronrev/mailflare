/**
 * Whether any error in the chain has a message matching `pattern`. Drizzle
 * wraps driver errors as "Failed query: …" and keeps the driver message on
 * `cause`, so checking only the outer message misses it. The patterns cover
 * SQLite/D1, PostgreSQL and MySQL wording.
 */
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
	let current: unknown = error;
	const visited = new Set<unknown>();
	while (current && !visited.has(current)) {
		visited.add(current);
		if (pattern.test(current instanceof Error ? current.message : String(current))) return true;
		if (typeof current !== "object" || !("cause" in current)) break;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

function errorChainMessages(error: unknown): string[] {
	const messages: string[] = [];
	let current: unknown = error;
	const visited = new Set<unknown>();
	while (current && !visited.has(current)) {
		visited.add(current);
		const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
		if (message && !messages.includes(message)) messages.push(message);
		if (typeof current !== "object" || !("cause" in current)) break;
		current = (current as { cause?: unknown }).cause;
	}
	return messages;
}

/**
 * The driver's own words for a failed query.
 *
 * Drizzle reports every failure as "Failed query: <sql> params: <values>" and
 * keeps the reason on `cause`, so a log line built from `message` alone says that
 * something failed and nothing about what — which is the same thing a 500 with an
 * empty body already said. This walks the chain and returns the informative part,
 * falling back to the outer message when the error did not come from a driver.
 */
export function describeDatabaseError(error: unknown): string {
	const messages = errorChainMessages(error);
	if (messages.length === 0) return error instanceof Error ? error.name : "Unknown database error";
	if (!/^Failed query/i.test(messages[0])) return messages[0];
	return messages.slice(1).join(" — caused by: ") || messages[0];
}

/** The table does not exist yet, for features whose migration may not be applied. */
export function isMissingTableError(error: unknown): boolean {
	return errorChainMatches(error, /no such table|relation "[^"]+" does not exist|table '[^']+' doesn't exist/i);
}

/** A column added by a migration that may not be applied yet. */
export function isMissingColumnError(error: unknown): boolean {
	return errorChainMatches(error, /no such column|has no column named|column "[^"]+" (of relation "[^"]+" )?does not exist|unknown column/i);
}

export function isUniqueConstraintError(error: unknown): boolean {
	return errorChainMatches(error, /UNIQUE constraint failed|duplicate key value violates unique constraint|duplicate entry/i);
}
