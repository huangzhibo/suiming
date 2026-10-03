import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactError } from "../artifact/errors.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface ObjectCollectionResult {
	kept: string[];
	removed: string[];
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function requireHash(hash: string): string {
	if (!HASH_PATTERN.test(hash)) throw new ArtifactError("invalid_object_hash", `Invalid object hash: ${hash}`);
	return hash;
}

export class ContentAddressedObjectStore {
	readonly rootPath: string;

	constructor(rootPath: string) {
		if (rootPath.trim().length === 0)
			throw new ArtifactError("invalid_object_store", "Object root must not be empty");
		this.rootPath = rootPath;
	}

	pathFor(hash: string): string {
		const valid = requireHash(hash);
		return join(this.rootPath, valid.slice(0, 2), valid.slice(2));
	}

	async put(bytes: Uint8Array): Promise<string> {
		const hash = hashBytes(bytes);
		const path = this.pathFor(hash);
		try {
			const existing = await readFile(path);
			if (hashBytes(existing) !== hash) {
				throw new ArtifactError("object_corrupt", `Object content does not match its path: ${hash}`);
			}
			return hash;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const directory = join(this.rootPath, hash.slice(0, 2));
		const temporaryPath = join(directory, `.object-${randomUUID()}.tmp`);
		await mkdir(directory, { recursive: true });
		try {
			await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
			await rename(temporaryPath, path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
		return hash;
	}

	async read(hash: string): Promise<Uint8Array> {
		const valid = requireHash(hash);
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(this.pathFor(valid)));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ArtifactError("object_not_found", `Object not found: ${valid}`);
			}
			throw error;
		}
		if (hashBytes(bytes) !== valid) throw new ArtifactError("object_corrupt", `Object hash mismatch: ${valid}`);
		return bytes;
	}

	async verify(hash: string): Promise<void> {
		await this.read(hash);
	}

	async collect(referencedHashes: ReadonlySet<string>): Promise<ObjectCollectionResult> {
		for (const hash of referencedHashes) requireHash(hash);
		const kept: string[] = [];
		const removed: string[] = [];
		let shards: string[];
		try {
			shards = await readdir(this.rootPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kept, removed };
			throw error;
		}
		for (const shard of shards.sort()) {
			if (!/^[a-f0-9]{2}$/u.test(shard)) continue;
			const shardPath = join(this.rootPath, shard);
			if (!(await stat(shardPath)).isDirectory()) continue;
			for (const name of (await readdir(shardPath)).sort()) {
				const hash = `${shard}${name}`;
				if (!HASH_PATTERN.test(hash)) continue;
				if (referencedHashes.has(hash)) {
					await this.verify(hash);
					kept.push(hash);
				} else {
					await rm(this.pathFor(hash));
					removed.push(hash);
				}
			}
		}
		return { kept, removed };
	}
}
