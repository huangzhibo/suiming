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

export function cloudObjectKey(contentHash: string): string {
	if (!/^[a-f0-9]{64}$/.test(contentHash)) {
		throw new CloudStoreError("invalid_cloud_store_input", "Object content hash must be 64 lowercase hex characters");
	}
	return `objects/sha256/${contentHash.slice(0, 2)}/${contentHash}`;
}
