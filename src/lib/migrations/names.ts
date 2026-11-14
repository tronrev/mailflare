/**
 * Names in the migrations table come from more than one writer: `wrangler d1 migrations apply` stores
 * the file name, while a hand-run repair script (see `scripts/sql/`) may store it without the `.sql`
 * suffix or with a directory in front. Every form proves the migration ran, so it must resolve to the
 * bundled file — otherwise the updater reports the same migration as unknown *and* as pending.
 */
export function matchBundledName(recorded: string, bundled: Set<string>): string | undefined {
	const trimmed = recorded.trim();
	if (bundled.has(trimmed)) return trimmed;

	const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
	const candidates = base === trimmed ? [`${trimmed}.sql`] : [base, `${base}.sql`];
	return candidates.find((candidate) => bundled.has(candidate));
}
