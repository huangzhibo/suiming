import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Buffer } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** 对象目录里的一个文件：内容寻址的对象（有 hash），或写到一半留下的临时文件。 */
export interface StoredObjectFile {
	path: string;
	hash?: string;
	modifiedAt: Date;
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
		const hash = sha256Buffer(bytes);
		const path = this.pathFor(hash);
		try {
			const existing = await readFile(path);
			if (sha256Buffer(existing) !== hash) {
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
		if (sha256Buffer(bytes) !== valid) throw new ArtifactError("object_corrupt", `Object hash mismatch: ${valid}`);
		return bytes;
	}

	/**
	 * 列出目录里的对象文件与写到一半的临时文件。删不删由持有引用的一方决定（`SqliteLocalStore.collectExecutionObjects`）：
	 * 只看目录判断不了一个文件是不是刚写进来、正要登记。
	 */
	async files(): Promise<StoredObjectFile[]> {
		const files: StoredObjectFile[] = [];
		let shards: string[];
		try {
			shards = await readdir(this.rootPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
			throw error;
		}
		for (const shard of shards.sort()) {
			if (!/^[a-f0-9]{2}$/u.test(shard)) continue;
			const shardPath = join(this.rootPath, shard);
			if (!(await stat(shardPath)).isDirectory()) continue;
			for (const name of (await readdir(shardPath)).sort()) {
				const hash = `${shard}${name}`;
				const temporary = /^\.object-.+\.tmp$/u.test(name);
				if (!temporary && !HASH_PATTERN.test(hash)) continue;
				const path = join(shardPath, name);
				const modifiedAt = await stat(path).then(
					(info) => info.mtime,
					() => undefined,
				);
				if (modifiedAt === undefined) continue;
				files.push({ path, ...(temporary ? {} : { hash }), modifiedAt });
			}
		}
		return files;
	}
}
