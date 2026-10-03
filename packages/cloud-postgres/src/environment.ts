import type { CreateCloudPostgresDatabaseOptions } from "./database.js";
import { CloudPostgresError } from "./errors.js";

export type CloudPostgresEnvironment = Readonly<Record<string, string | undefined>>;

function optional(environment: CloudPostgresEnvironment, name: string): string | undefined {
	const value = environment[name]?.trim();
	if (value === undefined || value.length === 0) return undefined;
	if (value.includes("\0")) throw new CloudPostgresError("invalid_cloud_postgres_config", `${name} contains NUL`);
	return value;
}

function positiveInteger(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new CloudPostgresError("invalid_cloud_postgres_config", `${name} must be a positive safe integer`);
	}
	return parsed;
}

/** Reads non-secret PostgreSQL tuning and its required connection URL at the process boundary. */
export function cloudPostgresConfigFromEnvironment(
	environment: CloudPostgresEnvironment = process.env,
	defaultApplicationName?: string,
): CreateCloudPostgresDatabaseOptions {
	const connectionString = optional(environment, "SUIMING_POSTGRES_URL");
	if (connectionString === undefined) {
		throw new CloudPostgresError("missing_cloud_postgres_config", "SUIMING_POSTGRES_URL must be configured");
	}
	const maxConnections = positiveInteger(
		optional(environment, "SUIMING_POSTGRES_MAX_CONNECTIONS"),
		"SUIMING_POSTGRES_MAX_CONNECTIONS",
	);
	const fallbackApplicationName = defaultApplicationName?.trim();
	if (fallbackApplicationName?.includes("\0")) {
		throw new CloudPostgresError("invalid_cloud_postgres_config", "defaultApplicationName contains NUL");
	}
	const applicationName =
		optional(environment, "SUIMING_POSTGRES_APPLICATION_NAME") ??
		(fallbackApplicationName === undefined || fallbackApplicationName.length === 0
			? undefined
			: fallbackApplicationName);
	return {
		connectionString,
		...(maxConnections === undefined ? {} : { maxConnections }),
		...(applicationName === undefined ? {} : { applicationName }),
	};
}
