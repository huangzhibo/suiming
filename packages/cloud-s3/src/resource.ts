import { S3Client } from "@aws-sdk/client-s3";
import { CloudStoreError } from "@suiming/runtime";
import { S3CloudObjectStore } from "./s3-cloud-object-store.js";

export interface S3CloudCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface CreateS3CloudObjectStoreResourceOptions {
	region: string;
	bucket: string;
	endpoint?: string;
	forcePathStyle?: boolean;
	keyPrefix?: string;
	credentials?: S3CloudCredentials;
}

export interface S3CloudObjectStoreResource {
	client: S3Client;
	objects: S3CloudObjectStore;
	close(): void;
}

export type S3CloudEnvironment = Readonly<Record<string, string | undefined>>;

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) throw new TypeError(`${label} must be non-empty`);
	return normalized;
}

function optional(environment: S3CloudEnvironment, name: string): string | undefined {
	const value = environment[name]?.trim();
	if (value === undefined || value.length === 0) return undefined;
	if (value.includes("\0")) throw new CloudStoreError("invalid_s3_config", `${name} contains NUL`);
	return value;
}

function optionalBoolean(value: string | undefined, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new CloudStoreError("invalid_s3_config", `${name} must be true or false`);
}

/** Reads S3-compatible client configuration without inventing development defaults. */
export function s3CloudObjectStoreConfigFromEnvironment(
	environment: S3CloudEnvironment = process.env,
): CreateS3CloudObjectStoreResourceOptions {
	const region = optional(environment, "SUIMING_S3_REGION");
	const bucket = optional(environment, "SUIMING_S3_BUCKET");
	if (region === undefined || bucket === undefined) {
		throw new CloudStoreError("missing_s3_config", "SUIMING_S3_REGION and SUIMING_S3_BUCKET must be configured");
	}
	const accessKeyId = optional(environment, "SUIMING_S3_ACCESS_KEY_ID");
	const secretAccessKey = optional(environment, "SUIMING_S3_SECRET_ACCESS_KEY");
	const sessionToken = optional(environment, "SUIMING_S3_SESSION_TOKEN");
	if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
		throw new CloudStoreError(
			"invalid_s3_config",
			"SUIMING_S3_ACCESS_KEY_ID and SUIMING_S3_SECRET_ACCESS_KEY must be configured together",
		);
	}
	if (sessionToken !== undefined && accessKeyId === undefined) {
		throw new CloudStoreError("invalid_s3_config", "SUIMING_S3_SESSION_TOKEN requires explicit S3 credentials");
	}
	const endpoint = optional(environment, "SUIMING_S3_ENDPOINT");
	const keyPrefix = optional(environment, "SUIMING_S3_KEY_PREFIX");
	const forcePathStyle = optionalBoolean(
		optional(environment, "SUIMING_S3_FORCE_PATH_STYLE"),
		"SUIMING_S3_FORCE_PATH_STYLE",
	);
	return {
		region,
		bucket,
		...(endpoint === undefined ? {} : { endpoint }),
		...(keyPrefix === undefined ? {} : { keyPrefix }),
		...(forcePathStyle === undefined ? {} : { forcePathStyle }),
		...(accessKeyId === undefined || secretAccessKey === undefined
			? {}
			: {
					credentials: {
						accessKeyId,
						secretAccessKey,
						...(sessionToken === undefined ? {} : { sessionToken }),
					},
				}),
	};
}

/** Creates and owns the S3 client used by a Cloud process composition root. */
export function createS3CloudObjectStoreResource(
	options: CreateS3CloudObjectStoreResourceOptions,
): S3CloudObjectStoreResource {
	const credentials =
		options.credentials === undefined
			? undefined
			: {
					accessKeyId: nonempty(options.credentials.accessKeyId, "S3 accessKeyId"),
					secretAccessKey: nonempty(options.credentials.secretAccessKey, "S3 secretAccessKey"),
					...(options.credentials.sessionToken === undefined
						? {}
						: { sessionToken: nonempty(options.credentials.sessionToken, "S3 sessionToken") }),
				};
	const client = new S3Client({
		region: nonempty(options.region, "S3 region"),
		...(options.endpoint === undefined ? {} : { endpoint: nonempty(options.endpoint, "S3 endpoint") }),
		...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
		...(credentials === undefined ? {} : { credentials }),
	});
	const objects = new S3CloudObjectStore({
		client,
		bucket: options.bucket,
		...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
	});
	return { client, objects, close: () => client.destroy() };
}
