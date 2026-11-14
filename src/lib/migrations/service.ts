import { isExternalDatabase } from "@/db/external";
import type { DatabaseDialect } from "@/db/dialect";
import sqliteBundle from "./bundle.json";
import mysqlBundle from "./bundle-mysql.json";
import postgresBundle from "./bundle-postgres.json";
import type { BundledMigration, MigrationNameFix, MigrationNameRow, MigrationResult, MigrationStatus } from "./types";
import { matchBundledName } from "./names";

const BUNDLES: Record<DatabaseDialect, BundledMigration[]> = {
	sqlite: sqliteBundle.migrations as BundledMigration[],
	postgres: postgresBundle.migrations as BundledMigration[],
	mysql: mysqlBundle.migrations as BundledMigration[],
};

/** D1 keeps the table name Wrangler uses, so `wrangler d1 migrations apply` and the in-app runner agree. */
const MIGRATION_TABLES: Record<DatabaseDialect, { table: string; create: string; exists: string }> = {
	sqlite: {
		table: "d1_migrations",
		create: "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
		exists: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'",
	},
	postgres: {
		table: "mailflare_migrations",
		create: "CREATE TABLE IF NOT EXISTS mailflare_migrations (id BIGSERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		exists: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'mailflare_migrations'",
	},
	mysql: {
		table: "mailflare_migrations",
		create: "CREATE TABLE IF NOT EXISTS mailflare_migrations (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(191) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
		exists: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = database() AND table_name = 'mailflare_migrations'",
	},
};

export function migrationDialect(db: D1Database): DatabaseDialect {
	return isExternalDatabase(db) ? db.config.dialect : "sqlite";
}

async function getAppliedMigrationNames(db: D1Database): Promise<string[]> {
	const { table, exists } = MIGRATION_TABLES[migrationDialect(db)];
	const found = await db.prepare(exists).first<MigrationNameRow>();
	if (!found) return [];

	const result = await db.prepare(`SELECT name FROM ${table}`).all<MigrationNameRow>();
	return result.results.map((row) => row.name);
}

export async function getMigrationStatus(db: D1Database): Promise<MigrationStatus> {
	const dialect = migrationDialect(db);
	const migrations = BUNDLES[dialect];
	const committed = new Set(migrations.map((migration) => migration.name));
	const records = await getAppliedMigrationNames(db);

	const applied = new Set<string>();
	const legacy: MigrationNameFix[] = [];
	const unknown: string[] = [];

	for (const record of records) {
		const matched = matchBundledName(record, committed);
		if (!matched) {
			unknown.push(record);
			continue;
		}

		applied.add(matched);
		// Only rewrite a name when the correct one is missing, so a database that already has both
		// the legacy and the canonical row is not asked to duplicate it.
		if (matched !== record && !records.includes(matched)) legacy.push({ from: record, to: matched });
	}

	legacy.sort((left, right) => left.from.localeCompare(right.from));
	unknown.sort();

	const pending = migrations.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);

	return {
		ready: pending.length === 0 && unknown.length === 0,
		pending,
		unknown,
		legacy,
		bundledCount: migrations.length,
		appliedCount: applied.size,
		table: MIGRATION_TABLES[dialect].table,
	};
}

export async function applyPendingMigrations(db: D1Database): Promise<MigrationResult> {
	const dialect = migrationDialect(db);
	const migrations = BUNDLES[dialect];
	const { table, create } = MIGRATION_TABLES[dialect];
	const initial = await getMigrationStatus(db);
	if (initial.unknown.length > 0) {
		throw new Error("The database contains migrations that are not part of this Mailflare release.");
	}

	await db.prepare(create).run();

	// Normalise hand-written records first, so the pending list below matches what is actually stored.
	if (initial.legacy.length > 0) {
		await db.batch(initial.legacy.map(({ from, to }) => db.prepare(`UPDATE ${table} SET name = ? WHERE name = ?`).bind(to, from)));
	}

	const applied: string[] = [];

	for (const name of initial.pending) {
		const migration = migrations.find((candidate) => candidate.name === name);
		if (!migration) continue;

		try {
			if (dialect === "mysql") {
				// MySQL commits DDL implicitly, so a transaction cannot make a migration atomic. Record it last,
				// so a failed migration is retried rather than skipped.
				for (const statement of migration.statements) await db.prepare(statement).run();
				await db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name).run();
			} else {
				await db.batch([
					db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).bind(name),
					...migration.statements.map((statement) => db.prepare(statement)),
				]);
			}
			applied.push(name);
		} catch (error) {
			if (dialect !== "mysql") {
				const completed = await db.prepare(`SELECT name FROM ${table} WHERE name = ?`).bind(name).first<MigrationNameRow>();
				if (completed) continue;
			}
			throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : "Database error"}`);
		}
	}

	return { ...(await getMigrationStatus(db)), applied };
}
