import { Value } from "typebox/value";
import { type DomainApiOpenStoryPackage, DomainApiOpenStoryPackageSchema } from "./schema.js";

export interface DomainApiOpenStoryFileContent {
	path: string;
	mediaType: string;
	bytes: Uint8Array;
}

export class DomainApiCodecError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DomainApiCodecError";
		this.code = code;
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

function encodeBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
	}
	return btoa(chunks.join(""));
}

function decodeBase64(value: string): Uint8Array {
	const decoded = atob(value);
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
	return bytes;
}

export async function encodeDomainApiContent(bytesValue: Uint8Array): Promise<{
	contentSha256: string;
	byteLength: number;
	contentBase64: string;
}> {
	const bytes = new Uint8Array(bytesValue);
	return {
		contentSha256: await sha256(bytes),
		byteLength: bytes.byteLength,
		contentBase64: encodeBase64(bytes),
	};
}

export async function decodeDomainApiContent(value: {
	contentBase64: string;
	contentSha256: string;
	byteLength: number;
}): Promise<Uint8Array> {
	const bytes = decodeBase64(value.contentBase64);
	if (bytes.byteLength !== value.byteLength) {
		throw new DomainApiCodecError("content_length_mismatch", "Content length does not match metadata");
	}
	if ((await sha256(bytes)) !== value.contentSha256) {
		throw new DomainApiCodecError("content_hash_mismatch", "Content hash does not match metadata");
	}
	return bytes;
}

async function fingerprint(
	files: readonly { path: string; mediaType: string; contentSha256: string; byteLength: number }[],
): Promise<string> {
	const descriptors = [...files]
		.map(({ path, mediaType, contentSha256, byteLength }) => ({
			path,
			mediaType,
			contentSha256,
			byteLength,
		}))
		.sort((left, right) => compareCodeUnits(left.path, right.path));
	return `sha256:${await sha256(new TextEncoder().encode(canonicalJson(descriptors)))}`;
}

export async function encodeDomainApiOpenStoryPackage(
	files: readonly DomainApiOpenStoryFileContent[],
): Promise<DomainApiOpenStoryPackage> {
	if (files.length === 0) throw new DomainApiCodecError("empty_open_story_package", "Open Story Package is empty");
	const paths = new Set<string>();
	const encoded = [];
	for (const source of files) {
		if (paths.has(source.path)) {
			throw new DomainApiCodecError("duplicate_logical_path", `Duplicate Open Story path: ${source.path}`);
		}
		paths.add(source.path);
		encoded.push({
			path: source.path,
			mediaType: source.mediaType,
			...(await encodeDomainApiContent(source.bytes)),
		});
	}
	const value: DomainApiOpenStoryPackage = {
		schemaVersion: 1,
		contentFingerprint: await fingerprint(encoded),
		// 包里的文件按路径的 UTF-16 码元排：同一份作品不论从哪边编码，线上是同一个顺序（与 Runtime 导出一致）。
		files: encoded.sort((left, right) => compareCodeUnits(left.path, right.path)),
	};
	if (!Value.Check(DomainApiOpenStoryPackageSchema, value)) {
		throw new DomainApiCodecError("invalid_open_story_package", "Open Story Package metadata is invalid");
	}
	return value;
}

export async function decodeDomainApiOpenStoryPackage(value: unknown): Promise<DomainApiOpenStoryFileContent[]> {
	if (!Value.Check(DomainApiOpenStoryPackageSchema, value)) {
		throw new DomainApiCodecError("invalid_open_story_package", "Open Story Package does not match the wire schema");
	}
	const wire = value as DomainApiOpenStoryPackage;
	const paths = new Set<string>();
	const files: DomainApiOpenStoryFileContent[] = [];
	for (const file of wire.files) {
		if (paths.has(file.path)) {
			throw new DomainApiCodecError("duplicate_logical_path", `Duplicate Open Story path: ${file.path}`);
		}
		paths.add(file.path);
		let bytes: Uint8Array;
		try {
			bytes = await decodeDomainApiContent(file);
		} catch (error) {
			if (error instanceof DomainApiCodecError) {
				throw new DomainApiCodecError(error.code, `${error.message}: ${file.path}`);
			}
			throw error;
		}
		files.push({ path: file.path, mediaType: file.mediaType, bytes });
	}
	if ((await fingerprint(wire.files)) !== wire.contentFingerprint) {
		throw new DomainApiCodecError(
			"package_fingerprint_mismatch",
			"Open Story Package fingerprint does not match files",
		);
	}
	return files;
}
