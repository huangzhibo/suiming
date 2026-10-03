import { createHash } from "node:crypto";
import {
	type ArtifactVersion,
	type CloudObjectStore,
	CloudStoreError,
	cloudObjectKey,
	type PreparedCloudArtifactVersion,
} from "@suiming/runtime";
import { type Kysely, sql } from "kysely";

export type PostgresExecutor = Kysely<Record<string, never>>;

export interface PostgresArtifactVersionRow {
	id: string;
	media_type: string;
	content_hash: string;
	byte_length: bigint | number | string;
	inline_bytes: Uint8Array | null;
	object_key: string | null;
}

export function postgresContentHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function expectedArtifactVersionId(mediaType: string, hash: string): string {
	return `av_${createHash("sha256").update(mediaType).update("\0").update(hash).digest("hex")}`;
}

function byteLength(value: PostgresArtifactVersionRow["byte_length"]): number | undefined {
	const result = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
	return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export class PostgresArtifactVersionStorage {
	readonly #objects: CloudObjectStore;
	readonly #integrityErrorCode: string;

	constructor(objects: CloudObjectStore, integrityErrorCode: string) {
		this.#objects = objects;
		this.#integrityErrorCode = integrityErrorCode;
	}

	async insert(executor: PostgresExecutor, versions: readonly PreparedCloudArtifactVersion[]): Promise<void> {
		for (const version of versions) {
			await sql`
				INSERT INTO suiming.artifact_versions
					(id, media_type, content_hash, byte_length, inline_bytes, object_key)
				VALUES (
					${version.id}, ${version.mediaType}, ${version.contentHash}, ${version.byteLength},
					${version.inlineBytes === null ? null : Buffer.from(version.inlineBytes)}, ${version.objectKey}
				)
				ON CONFLICT (id) DO NOTHING
			`.execute(executor);
			const stored = await this.row(executor, version.id);
			if (
				stored === undefined ||
				stored.media_type !== version.mediaType ||
				stored.content_hash !== version.contentHash ||
				byteLength(stored.byte_length) !== version.byteLength ||
				(stored.inline_bytes === null) === (stored.object_key === null) ||
				(stored.inline_bytes !== null &&
					(!sameBytes(stored.inline_bytes, version.inlineBytes ?? stored.inline_bytes) ||
						postgresContentHash(stored.inline_bytes) !== stored.content_hash)) ||
				(stored.object_key !== null && stored.object_key !== cloudObjectKey(stored.content_hash))
			) {
				throw this.#integrityError(`ArtifactVersion conflicts with stored metadata: ${version.id}`);
			}
		}
	}

	async read(executor: PostgresExecutor, id: string, notFound: () => Error): Promise<ArtifactVersion> {
		const row = await this.row(executor, id);
		if (row === undefined) throw notFound();
		return this.materialize(row);
	}

	async row(executor: PostgresExecutor, id: string): Promise<PostgresArtifactVersionRow | undefined> {
		const result = await sql<PostgresArtifactVersionRow>`
			SELECT id, media_type, content_hash, byte_length, inline_bytes, object_key
			FROM suiming.artifact_versions
			WHERE id = ${id}
		`.execute(executor);
		return result.rows[0];
	}

	async materialize(row: PostgresArtifactVersionRow): Promise<ArtifactVersion> {
		const expectedId = expectedArtifactVersionId(row.media_type, row.content_hash);
		if (row.id !== expectedId || !/^[a-f0-9]{64}$/u.test(row.content_hash)) {
			throw this.#integrityError(`ArtifactVersion metadata changed: ${row.id}`);
		}
		const expectedLength = byteLength(row.byte_length);
		if (expectedLength === undefined) {
			throw this.#integrityError(`ArtifactVersion byte length is invalid: ${row.id}`);
		}
		let bytes: Uint8Array;
		if (row.inline_bytes !== null && row.object_key === null) {
			bytes = new Uint8Array(row.inline_bytes);
		} else if (row.inline_bytes === null && row.object_key !== null) {
			if (row.object_key !== cloudObjectKey(row.content_hash)) {
				throw this.#integrityError(`ArtifactVersion object key changed: ${row.id}`);
			}
			bytes = await this.#objects.read(row.content_hash);
		} else {
			throw this.#integrityError(`ArtifactVersion storage is invalid: ${row.id}`);
		}
		if (bytes.byteLength !== expectedLength || postgresContentHash(bytes) !== row.content_hash) {
			throw this.#integrityError(`ArtifactVersion content changed: ${row.id}`);
		}
		return { id: row.id, mediaType: row.media_type, bytes: new Uint8Array(bytes) };
	}

	#integrityError(message: string): CloudStoreError {
		return new CloudStoreError(this.#integrityErrorCode, message);
	}
}
