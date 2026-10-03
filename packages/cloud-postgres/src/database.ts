import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";

export type CloudPostgresDatabase = Kysely<Record<string, never>>;

export interface CreateCloudPostgresDatabaseOptions {
	connectionString: string;
	maxConnections?: number;
	applicationName?: string;
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) throw new TypeError(`${label} must be non-empty`);
	return normalized;
}

/** Creates the shared Kysely/pg boundary. The caller owns and must destroy the returned database. */
export function createCloudPostgresDatabase(options: CreateCloudPostgresDatabaseOptions): CloudPostgresDatabase {
	const config: PoolConfig = {
		connectionString: nonempty(options.connectionString, "connectionString"),
		...(options.maxConnections === undefined ? {} : { max: options.maxConnections }),
		...(options.applicationName === undefined
			? {}
			: { application_name: nonempty(options.applicationName, "applicationName") }),
	};
	return new Kysely({ dialect: new PostgresDialect({ pool: new Pool(config) }) });
}
