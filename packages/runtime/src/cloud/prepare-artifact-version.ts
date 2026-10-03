import { sha256Buffer } from "@suiming/story";
import { artifactVersionId, shouldInlineArtifactVersion } from "../artifact/version-storage.js";
import { CloudStoreError } from "./errors.js";
import { type CloudObjectStore, cloudObjectKey } from "./object-store.js";

export interface PreparedCloudArtifactVersion {
	id: string;
	mediaType: string;
	contentHash: string;
	byteLength: number;
	inlineBytes: Uint8Array | null;
	objectKey: string | null;
}

export interface PrepareCloudArtifactVersionOptions {
	inlineTextThresholdBytes?: number;
}

export async function prepareCloudArtifactVersion(
	mediaTypeValue: string,
	bytes: Uint8Array,
	objects: CloudObjectStore,
	options: PrepareCloudArtifactVersionOptions = {},
): Promise<PreparedCloudArtifactVersion> {
	const mediaType = mediaTypeValue.trim();
	if (mediaType.length === 0 || mediaType.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_store_input", "Artifact mediaType is invalid");
	}
	const threshold = options.inlineTextThresholdBytes ?? 256 * 1024;
	if (!Number.isSafeInteger(threshold) || threshold < 0) {
		throw new CloudStoreError(
			"invalid_cloud_store_input",
			"inlineTextThresholdBytes must be a non-negative safe integer",
		);
	}
	const contentHash = sha256Buffer(bytes);
	const id = artifactVersionId(mediaType, contentHash);
	if (shouldInlineArtifactVersion(mediaType, bytes.byteLength, threshold)) {
		return {
			id,
			mediaType,
			contentHash,
			byteLength: bytes.byteLength,
			inlineBytes: new Uint8Array(bytes),
			objectKey: null,
		};
	}

	const stored = await objects.put(bytes);
	const expectedKey = cloudObjectKey(contentHash);
	if (
		stored.contentHash !== contentHash ||
		stored.objectKey !== expectedKey ||
		stored.byteLength !== bytes.byteLength
	) {
		throw new CloudStoreError("cloud_object_integrity_error", "Cloud object store returned inconsistent metadata");
	}
	return {
		id,
		mediaType,
		contentHash,
		byteLength: bytes.byteLength,
		inlineBytes: null,
		objectKey: expectedKey,
	};
}
