import { createHash } from "node:crypto";
import { CLOUD_POSTGRES_MIGRATIONS, type CloudPostgresMigration } from "@suiming/runtime";
import { type Kysely, sql } from "kysely";
import type { CloudPostgresDatabase } from "./database.js";
import { CloudPostgresError } from "./errors.js";

const MIGRATION_LOCK_NAME = "suiming.cloud-postgres.migrations.v1";

export interface CloudPostgresMigrationResult {
	applied: string[];
	alreadyApplied: string[];
}

interface AppliedMigrationRow {
	id: string;
	checksum: string;
}

function validateMigrations(migrations: readonly CloudPostgresMigration[]): void {
	const ids = new Set<string>();
	for (const migration of migrations) {
		if (migration.id.trim() !== migration.id || migration.id.length === 0 || migration.id.includes("\0")) {
			throw new CloudPostgresError(
				"invalid_postgres_migration",
				"Migration id must be a non-empty normalized string",
			);
		}
		if (ids.has(migration.id)) {
			throw new CloudPostgresError("invalid_postgres_migration", `Duplicate migration id: ${migration.id}`);
		}
		if (
			migration.statements.length === 0 ||
			migration.statements.some((statement) => statement.trim().length === 0)
		) {
			throw new CloudPostgresError(
				"invalid_postgres_migration",
				`Migration ${migration.id} must contain non-empty SQL statements`,
			);
		}
		ids.add(migration.id);
	}
}

export function cloudPostgresMigrationChecksum(migration: CloudPostgresMigration): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify([migration.id, [...migration.statements]]))
		.digest("hex")}`;
}

async function bootstrap(transaction: Kysely<Record<string, never>>): Promise<void> {
	await sql`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_NAME}))`.execute(transaction);
	await sql.raw("CREATE SCHEMA IF NOT EXISTS suiming").execute(transaction);
	await sql
		.raw(`CREATE TABLE IF NOT EXISTS suiming.schema_migrations (
			id text PRIMARY KEY,
			checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
			applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
		)`)
		.execute(transaction);
}

function verifyAppliedPrefix(
	migrations: readonly CloudPostgresMigration[],
	appliedRows: readonly AppliedMigrationRow[],
): number {
	const known = new Map(migrations.map((migration, index) => [migration.id, { migration, index }]));
	const applied = new Map<string, AppliedMigrationRow>();
	for (const row of appliedRows) {
		const expected = known.get(row.id);
		if (expected === undefined) {
			throw new CloudPostgresError("unknown_postgres_migration", `Database contains unknown migration: ${row.id}`);
		}
		const checksum = cloudPostgresMigrationChecksum(expected.migration);
		if (row.checksum !== checksum) {
			throw new CloudPostgresError(
				"postgres_migration_checksum_mismatch",
				`Migration ${row.id} changed after it was applied`,
			);
		}
		applied.set(row.id, row);
	}

	let prefixLength = 0;
	while (prefixLength < migrations.length && applied.has(migrations[prefixLength]?.id as string)) {
		prefixLength += 1;
	}
	const outOfOrder = migrations.slice(prefixLength).find((migration) => applied.has(migration.id));
	if (outOfOrder !== undefined) {
		throw new CloudPostgresError(
			"postgres_migration_history_gap",
			`Migration ${outOfOrder.id} was applied before an earlier migration`,
		);
	}
	return prefixLength;
}

/** Applies the immutable Runtime migration catalog under one PostgreSQL advisory transaction lock. */
export async function migrateCloudPostgres(
	database: CloudPostgresDatabase,
	migrations: readonly CloudPostgresMigration[] = CLOUD_POSTGRES_MIGRATIONS,
): Promise<CloudPostgresMigrationResult> {
	validateMigrations(migrations);
	return database.transaction().execute(async (transaction) => {
		await bootstrap(transaction);
		const rows = await sql<AppliedMigrationRow>`
			SELECT id, checksum
			FROM suiming.schema_migrations
			ORDER BY id
		`.execute(transaction);
		const prefixLength = verifyAppliedPrefix(migrations, rows.rows);
		const alreadyApplied = migrations.slice(0, prefixLength).map((migration) => migration.id);
		const applied: string[] = [];
		for (const migration of migrations.slice(prefixLength)) {
			for (const statement of migration.statements) await sql.raw(statement).execute(transaction);
			await sql`
				INSERT INTO suiming.schema_migrations (id, checksum)
				VALUES (${migration.id}, ${cloudPostgresMigrationChecksum(migration)})
			`.execute(transaction);
			applied.push(migration.id);
		}
		return { applied, alreadyApplied };
	});
}
