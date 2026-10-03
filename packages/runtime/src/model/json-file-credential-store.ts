import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { lock } from "proper-lockfile";
import { ModelGatewayError } from "./errors.js";

interface CredentialFile {
	version: 1;
	credentials: Record<string, Credential>;
}

export interface JsonFileCredentialStoreOptions {
	path?: string;
}

function credentialFileError(message: string, cause?: unknown): ModelGatewayError {
	return new ModelGatewayError(
		"credential_store_error",
		cause instanceof Error ? `${message}: ${cause.message}` : message,
	);
}

function validateCredential(providerId: string, value: unknown): Credential {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		throw credentialFileError(`Credential for ${providerId} is invalid`);
	}
	const record = value as Record<string, unknown>;
	if (record.type === "api_key") {
		if (record.key !== undefined && typeof record.key !== "string") {
			throw credentialFileError(`API key credential for ${providerId} is invalid`);
		}
		if (record.env !== undefined) {
			if (typeof record.env !== "object" || record.env === null || Array.isArray(record.env)) {
				throw credentialFileError(`Credential environment for ${providerId} is invalid`);
			}
			for (const item of Object.values(record.env)) {
				if (typeof item !== "string")
					throw credentialFileError(`Credential environment for ${providerId} is invalid`);
			}
		}
		return structuredClone(value) as Credential;
	}
	if (
		record.type === "oauth" &&
		typeof record.refresh === "string" &&
		typeof record.access === "string" &&
		typeof record.expires === "number" &&
		Number.isFinite(record.expires)
	) {
		return structuredClone(value) as Credential;
	}
	throw credentialFileError(`Credential for ${providerId} has an unsupported type`);
}

function validateFile(value: unknown): CredentialFile {
	if (typeof value !== "object" || value === null) throw credentialFileError("auth.json must be an object");
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.credentials !== "object" || record.credentials === null) {
		throw credentialFileError("auth.json must contain version = 1 and a credentials object");
	}
	const credentials: Record<string, Credential> = {};
	for (const [providerId, credential] of Object.entries(record.credentials)) {
		if (providerId.trim().length === 0 || providerId.includes("\0")) {
			throw credentialFileError("auth.json contains an invalid provider id");
		}
		credentials[providerId] = validateCredential(providerId, credential);
	}
	return { version: 1, credentials };
}

export class JsonFileCredentialStore implements CredentialStore {
	readonly path: string;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: JsonFileCredentialStoreOptions = {}) {
		// 与 SUIMING_CONFIG_PATH 对称：测试和多套环境用它把凭据文件挪开，不碰 ~/.suiming。
		this.path = options.path ?? process.env.SUIMING_AUTH_PATH ?? join(homedir(), ".suiming", "auth.json");
	}

	async #readFile(options?: AuthOperationOptions): Promise<CredentialFile> {
		options?.signal?.throwIfAborted();
		try {
			const fileStat = await lstat(this.path);
			if (fileStat.isSymbolicLink()) {
				throw new ModelGatewayError(
					"credential_store_permissions",
					`Credential file must not be a symlink: ${this.path}`,
				);
			}
			if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
				throw new ModelGatewayError(
					"credential_store_permissions",
					`Credential file must use mode 0600: ${this.path}`,
				);
			}
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
			options?.signal?.throwIfAborted();
			return validateFile(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, credentials: {} };
			if (error instanceof ModelGatewayError) throw error;
			throw credentialFileError(`Cannot read ${this.path}`, error);
		}
	}

	async #writeFile(file: CredentialFile, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		const directory = dirname(this.path);
		const temporaryPath = join(directory, `.auth-${randomUUID()}.tmp`);
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(temporaryPath, `${JSON.stringify(file, null, "\t")}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			options?.signal?.throwIfAborted();
			await rename(temporaryPath, this.path);
			await chmod(this.path, 0o600);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw credentialFileError(`Cannot write ${this.path}`, error);
		}
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const current = this.#chain.then(task, task);
		this.#chain = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}

	/**
	 * 持跨进程文件锁执行整次读改写，包括 OAuth 刷新的远端请求。pi-ai 约定刷新在 `modify` 里跑，为的就是全局只刷一次：
	 * OpenAI 的 refresh token 用过一次就作废，桌面与 CLI 各刷一次，后到的那个拿着作废的 token 失败，作者只能重新登录。
	 * 2026-10-02 之前刷新在锁外、写回时比对，两边照样各刷一次。登录时浏览器里的等待不在 `modify` 里
	 * （`Models.login` 拿到凭据才写），不会占着锁。
	 */
	async #withWriteLock<T>(body: (assertHeld: () => void) => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		options?.signal?.throwIfAborted();
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const path = join(await realpath(dirname(this.path)), basename(this.path));
		let compromised: Error | undefined;
		const release = await lock(path, {
			realpath: false,
			stale: 10000,
			// 等锁要等得过别人的一次刷新（pi-ai 的刷新超时是 15 秒）。
			retries: { retries: 250, factor: 1, minTimeout: 100, maxTimeout: 100 },
			// 默认在计时器里抛错，会带崩桌面主进程；记下来，写之前拒绝（合盖睡眠后锁可能被当成过期锁收走）。
			onCompromised: (error) => {
				compromised = error;
			},
		});
		try {
			options?.signal?.throwIfAborted();
			return await body(() => {
				if (compromised) throw credentialFileError("Credential file lock was lost", compromised);
			});
		} finally {
			await release().catch((error: unknown) => {
				if (!compromised) throw error;
			});
		}
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const file = await this.#readFile(options);
		const credential = file.credentials[providerId];
		return credential === undefined ? undefined : structuredClone(credential);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const file = await this.#readFile(options);
		return Object.entries(file.credentials)
			.map(([providerId, credential]) => ({ providerId, type: credential.type }))
			.sort((left, right) => left.providerId.localeCompare(right.providerId));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#enqueue(() =>
			this.#withWriteLock(async (assertHeld) => {
				const file = await this.#readFile(options);
				const current = file.credentials[providerId];
				const next = await fn(current === undefined ? undefined : structuredClone(current));
				options?.signal?.throwIfAborted();
				if (next === undefined) return current === undefined ? undefined : structuredClone(current);
				file.credentials[providerId] = validateCredential(providerId, next);
				assertHeld();
				await this.#writeFile(file, options);
				return structuredClone(next);
			}, options),
		);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#enqueue(() =>
			this.#withWriteLock(async () => {
				const file = await this.#readFile(options);
				if (!(providerId in file.credentials)) return;
				delete file.credentials[providerId];
				await this.#writeFile(file, options);
			}, options),
		);
	}
}
