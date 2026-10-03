import { createHash } from "node:crypto";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	type GetObjectCommandOutput,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { type CloudObjectStore, type CloudStoredObject, CloudStoreError, cloudObjectKey } from "@suiming/runtime";

export interface S3CloudObjectStoreOptions {
	client: S3Client;
	bucket: string;
	keyPrefix?: string;
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_store_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function normalizePrefix(value: string | undefined): string {
	if (value === undefined || value.trim().length === 0) return "";
	const normalized = value.trim().replace(/^\/+|\/+$/gu, "");
	if (
		normalized.length === 0 ||
		normalized.includes("\0") ||
		normalized.split("/").some((part) => part.length === 0)
	) {
		throw new CloudStoreError("invalid_cloud_store_input", "S3 keyPrefix is invalid");
	}
	return `${normalized}/`;
}

function sha256(bytes: Uint8Array): { hex: string; base64: string } {
	const hash = createHash("sha256").update(bytes);
	return { hex: hash.copy().digest("hex"), base64: hash.digest("base64") };
}

function isNotFound(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const value = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } };
	return (
		value.name === "NoSuchKey" ||
		value.name === "NotFound" ||
		value.Code === "NoSuchKey" ||
		value.$metadata?.httpStatusCode === 404
	);
}

function externalError(operation: string, error: unknown): CloudStoreError {
	const name =
		typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
			? error.name
			: "unknown_error";
	return new CloudStoreError("cloud_object_store_error", `S3 ${operation} failed: ${name}`);
}

/** S3-compatible content-addressed implementation of Runtime's CloudObjectStore port. */
export class S3CloudObjectStore implements CloudObjectStore {
	readonly #client: S3Client;
	readonly #bucket: string;
	readonly #keyPrefix: string;

	constructor(options: S3CloudObjectStoreOptions) {
		this.#client = options.client;
		this.#bucket = nonempty(options.bucket, "S3 bucket");
		this.#keyPrefix = normalizePrefix(options.keyPrefix);
	}

	async put(bytes: Uint8Array): Promise<CloudStoredObject> {
		const content = new Uint8Array(bytes);
		const contentHash = sha256(content);
		const objectKey = cloudObjectKey(contentHash.hex);
		try {
			await this.#client.send(
				new PutObjectCommand({
					Bucket: this.#bucket,
					Key: this.#physicalKey(objectKey),
					Body: content,
					ChecksumSHA256: contentHash.base64,
					Metadata: {
						"suiming-sha256": contentHash.hex,
						"suiming-byte-length": String(content.byteLength),
					},
				}),
			);
		} catch (error) {
			throw externalError("put", error);
		}
		return { contentHash: contentHash.hex, objectKey, byteLength: content.byteLength };
	}

	async read(contentHashValue: string): Promise<Uint8Array> {
		const objectKey = cloudObjectKey(contentHashValue);
		let response: GetObjectCommandOutput;
		try {
			response = await this.#client.send(
				new GetObjectCommand({ Bucket: this.#bucket, Key: this.#physicalKey(objectKey) }),
			);
		} catch (error) {
			if (isNotFound(error)) {
				throw new CloudStoreError("cloud_object_not_found", `Cloud object not found: ${contentHashValue}`);
			}
			throw externalError("read", error);
		}
		if (!("Body" in response) || response.Body === undefined) {
			throw new CloudStoreError("cloud_object_integrity_error", `S3 object has no body: ${objectKey}`);
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await response.Body.transformToByteArray());
		} catch (error) {
			throw externalError("read body", error);
		}
		const actual = sha256(bytes);
		const metadata = response.Metadata;
		const declaredLength = metadata?.["suiming-byte-length"];
		if (
			actual.hex !== contentHashValue ||
			(response.ContentLength !== undefined && response.ContentLength !== bytes.byteLength) ||
			(metadata?.["suiming-sha256"] !== undefined && metadata["suiming-sha256"] !== contentHashValue) ||
			(declaredLength !== undefined && declaredLength !== String(bytes.byteLength)) ||
			(response.ChecksumSHA256 !== undefined && response.ChecksumSHA256 !== actual.base64)
		) {
			throw new CloudStoreError("cloud_object_integrity_error", `S3 object content is invalid: ${objectKey}`);
		}
		return bytes;
	}

	async delete(contentHash: string): Promise<void> {
		const objectKey = cloudObjectKey(contentHash);
		try {
			await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#physicalKey(objectKey) }));
		} catch (error) {
			throw externalError("delete", error);
		}
	}

	#physicalKey(objectKey: string): string {
		return `${this.#keyPrefix}${objectKey}`;
	}
}
