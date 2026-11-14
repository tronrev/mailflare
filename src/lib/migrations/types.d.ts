export interface BundledMigration {
	name: string;
	statements: string[];
}

export interface MigrationNameFix {
	from: string;
	to: string;
}

export interface MigrationStatus {
	ready: boolean;
	pending: string[];
	unknown: string[];
	/** Records whose name differs from the bundled file (e.g. written without the `.sql` suffix). */
	legacy: MigrationNameFix[];
	/** How many migrations this release bundles, and how many the database records as applied. */
	bundledCount: number;
	appliedCount: number;
	/** Table that records applied migrations, so an operator can inspect or repair it by hand. */
	table: string;
}

export interface MigrationResult extends MigrationStatus {
	applied: string[];
}

export interface MigrationNameRow {
	name: string;
}
