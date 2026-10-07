import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { ArtifactError } from "../artifact/errors.js";

interface LockFile {
	version: 1;
	token: string;
	pid: number;
	hostname: string;
	createdAt: string;
}

export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** session lease 的持有进程还在不在：只认本机、pid 还活着的；别的机器上的持有者无从判断，按已不在处理。 */
export function leaseHolderAlive(lease: { pid: number; hostname: string }): boolean {
	return lease.hostname === hostname() && processExists(lease.pid);
}

export class LocalProjectLock {
	readonly path: string;
	readonly #token: string;
	#released = false;

	private constructor(path: string, token: string) {
		this.path = path;
		this.#token = token;
	}

	/**
	 * 锁只覆盖 open 与 commit 这类短临界区。持有者是本机活进程时最多等 waitMs 再判 `project_locked`：
	 * host agent 常并行发起几条 `suim` 命令，立刻失败会把一次几十毫秒的重叠变成作者要处理的错误。
	 */
	static async acquire(checkoutPath: string, options: { waitMs?: number } = {}): Promise<LocalProjectLock> {
		const path = join(checkoutPath, ".suiming", "project.lock");
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + (options.waitMs ?? 0);
		for (let attempt = 0; ; attempt += 1) {
			const token = randomUUID();
			const value: LockFile = {
				version: 1,
				token,
				pid: process.pid,
				hostname: hostname(),
				createdAt: new Date().toISOString(),
			};
			try {
				const handle = await open(path, "wx", 0o600);
				try {
					await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
				} finally {
					await handle.close();
				}
				return new LocalProjectLock(path, token);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				// 建文件与写内容不是一步：别人刚建好还没写完时读到空的或半截的，刚放掉时读不到文件。
				// 前者当作有人持有、照常等，后者马上再抢；等到期限还读不出才报错（崩在建文件与写内容之间留下的）。
				// 2026-10-07 之前读不出就立刻失败，20 个同时抢锁的约有 5% 白白失败。
				let existing: LockFile | undefined;
				try {
					existing = JSON.parse(await readFile(path, "utf8")) as LockFile;
				} catch (readError) {
					if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
					if (Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 50));
						continue;
					}
					throw new ArtifactError("project_locked", `作品锁文件存在，但读不出是谁持有：${path}`);
				}
				if (existing.hostname === hostname() && Number.isInteger(existing.pid) && !processExists(existing.pid)) {
					if (attempt > 4) throw new ArtifactError("project_locked", `拿不到作品锁：${path}`);
					await rm(path).catch(() => undefined);
					continue;
				}
				if (Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					continue;
				}
				throw new ArtifactError(
					"project_locked",
					`作品正被另一个进程使用（${existing.hostname} 上的 pid ${existing.pid}），稍后再试`,
				);
			}
		}
	}

	async release(): Promise<void> {
		if (this.#released) return;
		let existing: LockFile;
		try {
			existing = JSON.parse(await readFile(this.path, "utf8")) as LockFile;
		} catch (error) {
			throw new ArtifactError("project_lock_lost", `Project lock disappeared: ${(error as Error).message}`);
		}
		if (existing.token !== this.#token)
			throw new ArtifactError("project_lock_lost", "Project lock ownership changed");
		await rm(this.path);
		this.#released = true;
	}
}
