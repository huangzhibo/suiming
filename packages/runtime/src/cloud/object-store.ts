import { sha256Buffer } from "@suiming/story";
import { CloudStoreError } from "./errors.js";

export interface CloudStoredObject {
	contentHash: string;
	objectKey: string;
	byteLength: number;
}

export interface CloudObjectStore {
	put(bytes: Uint8Array): Promise<CloudStoredObject>;
	read(contentHash: string): Promise<Uint8Array>;
	delete(contentHash: string): Promise<void>;
}

export class InMemoryCloudObjectStore implements CloudObjectStore {
	readonly #objects = new Map<string, Uint8Array>();

	async put(bytes: Uint8Array): Promise<CloudStoredObject> {
		const contentHash = sha256Buffer(bytes);
		this.#objects.set(contentHash, new Uint8Array(bytes));
		return { contentHash, objectKey: cloudObjectKey(contentHash), byteLength: bytes.byteLength };
	}

	async read(contentHash: string): Promise<Uint8Array> {
		cloudObjectKey(contentHash);
		const bytes = this.#objects.get(contentHash);
		if (bytes === undefined) {
			throw new CloudStoreError("cloud_object_not_found", `Cloud object not found: ${contentHash}`);
		}
		return new Uint8Array(bytes);
	}

	async delete(contentHash: string): Promise<void> {
		cloudObjectKey(contentHash);
		this.#objects.delete(contentHash);
	}
}

export function cloudObjectKey(contentHash: string): string {
	if (!/^[a-f0-9]{64}$/.test(contentHash)) {
		throw new CloudStoreError("invalid_cloud_store_input", "Object content hash must be 64 lowercase hex characters");
	}
	return `objects/sha256/${contentHash.slice(0, 2)}/${contentHash}`;
}
