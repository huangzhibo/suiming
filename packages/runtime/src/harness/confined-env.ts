import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { confinedPath } from "../files/confined-path.js";
import { ToolRejection } from "./tool.js";

/** 谁都不能经这里读写的根：git 仓自身与 Suiming 的私有目录。其余整个 checkout 都能写，合法性由 codec / Checker 在 commit 判。 */
const PRIVATE_ROOTS = new Set([".git", ".suiming"]);
/**
 * `suim init / update --agent` 写的 host 接入目录（`apps/cli/src/host-install.ts`）：Skill、它带的 Story Language 副本、
 * Codex 的 agent 配置。那是写给 Codex / Claude Code / Grok 的说明——跑 `suim` 命令、派 host 自己的子 agent——
 * Suiming Agent 两样都没有，读了只会拿到用不上的指令；它们又是仓库辅助文件，改了不进版本、turn 对账也看不见。
 * 所以模型的文件工具列不出、读不到、写不了，作者的文件视图照常可见。入口文件 AGENTS.md / CLAUDE.md 不在此列：
 * 作者可能在 Suiming 标记段之外写了自己的东西；Agent 看得见，但不自动加载，作品要长期遵守的约束在 intent/**。
 */
export const HOST_ADAPTER_ROOTS: ReadonlySet<string> = new Set([".agents", ".claude", ".codex", ".grok"]);
export type ConfinedEnvPolicy = "read" | "write";

export interface ConfinedEnvOptions {
	rootPath: string;
	policy: ConfinedEnvPolicy;
	/** 缺省是给模型的环境，看不见 host 接入目录；作者的文件视图传 `"visible"`。 */
	hostAdapters?: "hidden" | "visible";
	/** 角色的写范围（writer 只写一个 Beat、source-extractor 只写自己的 Source、Reviewer 只写 review/**）；缺省整个 checkout。 */
	writable?: (logicalPath: string) => boolean;
	readable?: (logicalPath: string) => boolean;
}

export interface FileMutation {
	path: string;
	before: string | null;
	after: string | null;
	/** 写入字节的 base64（不是原文），先随动作 journal 保存；删除为 null。 */
	content: string | null;
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * 模型把目录当文件读、写、删：这是它能自己改正的路径错误，必须作为工具拒绝回到它手里。原样抛出的 EISDIR
 * 会被 loop 当成基础设施故障，整个 turn 结束——2026-10-01 真实模型回归里委派的 Writer 就这么白跑了一轮。
 */
function directoryRejection(path: string, error: unknown): ToolRejection | undefined {
	if ((error as NodeJS.ErrnoException)?.code !== "EISDIR") return undefined;
	return new ToolRejection("is_a_directory", `${path} 是目录，不是文件；看里面有什么用 list`, { cause: error });
}

/** 仅提供作品文件能力；无 shell、任意临时目录或通用进程接口。 */
export class ConfinedExecutionEnv {
	readonly rootPath: string;
	readonly #options: ConfinedEnvOptions;

	constructor(options: ConfinedEnvOptions) {
		this.rootPath = resolve(options.rootPath);
		this.#options = options;
	}

	/** 这个环境里看不见的根。macOS 默认不分大小写，`.Claude/` 打开的就是 `.claude/`，所以按小写比。 */
	#hiddenRoot(root: string): "private" | "host-adapter" | undefined {
		const name = root.toLowerCase();
		if (PRIVATE_ROOTS.has(name)) return "private";
		if (this.#options.hostAdapters !== "visible" && HOST_ADAPTER_ROOTS.has(name)) return "host-adapter";
		return undefined;
	}

	async #confine(path: string, write = false): Promise<{ absolute: string; logical: string }> {
		if (path.includes("\0") || path.startsWith("~") || path.startsWith("file://")) {
			throw new ToolRejection("permission_denied", `Invalid checkout path: ${path}`);
		}
		const absolute = resolve(this.rootPath, path);
		const logical = relative(this.rootPath, absolute).split(sep).join("/");
		if (logical === ".." || logical.startsWith("../") || isAbsolute(logical)) {
			throw new ToolRejection("permission_denied", `Path is outside the checkout: ${path}`);
		}
		try {
			await confinedPath(this.rootPath, absolute);
		} catch (error) {
			if ((error as { code?: string }).code === "unsafe_file_path")
				throw new ToolRejection("permission_denied", `Symlinks or escaped paths are not allowed: ${path}`, {
					cause: error,
				});
			throw error;
		}
		const root = logical.split("/")[0] ?? "";
		const hidden = logical ? this.#hiddenRoot(root) : undefined;
		if (hidden === "private") throw new ToolRejection("permission_denied", `${root}/ 是私有目录，不能读写`);
		if (hidden === "host-adapter")
			throw new ToolRejection(
				"permission_denied",
				`${root}/ 是 Codex / Claude Code / Grok 的接入文件，不是作品，不能读写`,
			);
		if (logical && this.#options.readable && !this.#options.readable(logical))
			throw new ToolRejection("permission_denied", `This task may not read ${logical}`);
		if (write) {
			if (
				this.#options.policy !== "write" ||
				!logical ||
				(this.#options.writable && !this.#options.writable(logical))
			) {
				throw new ToolRejection("permission_denied", `This task may not modify ${logical || "the checkout root"}`);
			}
		}
		return { absolute, logical };
	}

	async readBinaryFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		signal?.throwIfAborted();
		const { absolute } = await this.#confine(path);
		try {
			const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				return await file.readFile({ signal });
			} finally {
				await file.close();
			}
		} catch (error) {
			if (missing(error)) throw new ToolRejection("file_not_found", path, { cause: error });
			throw directoryRejection(path, error) ?? error;
		}
	}

	async readTextFile(path: string, signal?: AbortSignal): Promise<string> {
		return new TextDecoder("utf-8", { fatal: true }).decode(await this.readBinaryFile(path, signal));
	}

	/**
	 * 给模型看的一层目录：完整逻辑路径，目录带斜杠。.git / .suiming、host 接入目录、symlink 与读范围之外的文件不列出——
	 * 名字本身就会把模型引向读不到的东西。
	 */
	async listEntries(path: string): Promise<string[]> {
		const { absolute, logical } = await this.#confine(path);
		let entries: Dirent[];
		try {
			entries = await readdir(absolute, { withFileTypes: true });
		} catch (error) {
			if (missing(error)) throw new ToolRejection("file_not_found", path, { cause: error });
			if ((error as NodeJS.ErrnoException)?.code === "ENOTDIR")
				throw new ToolRejection("not_a_directory", `${path} 是文件，不是目录；读内容用 read`, { cause: error });
			throw error;
		}
		const prefix = logical ? `${logical}/` : "";
		return entries
			.filter((entry) => !entry.isSymbolicLink() && (logical !== "" || this.#hiddenRoot(entry.name) === undefined))
			.flatMap((entry) => {
				const child = `${prefix}${entry.name}`;
				if (entry.isDirectory()) return [`${child}/`];
				if (!entry.isFile()) return [];
				return this.#options.readable && !this.#options.readable(child) ? [] : [child];
			})
			.sort();
	}

	async listDir(path: string): Promise<string[]> {
		const { absolute } = await this.#confine(path);
		try {
			return (await readdir(absolute)).sort();
		} catch (error) {
			if (missing(error)) throw new ToolRejection("file_not_found", path, { cause: error });
			throw error;
		}
	}

	async prepareWrite(path: string, content: string | Uint8Array | null): Promise<FileMutation> {
		const { absolute, logical } = await this.#confine(path, true);
		const before = await this.#readExisting(absolute, logical);
		const bytes = content === null ? null : typeof content === "string" ? Buffer.from(content, "utf8") : content;
		return {
			path: logical,
			before: before === null ? null : hash(before),
			after: bytes === null ? null : hash(bytes),
			content: bytes === null ? null : Buffer.from(bytes).toString("base64"),
		};
	}

	/** 调用方必须先持久保存整个 mutation；恢复读取原 journal，不能重新计算 before。 */
	async applyMutation(mutation: FileMutation, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const { absolute } = await this.#confine(mutation.path, true);
		const bytes = mutation.content === null ? null : Buffer.from(mutation.content, "base64");
		if ((bytes === null ? null : hash(bytes)) !== mutation.after) throw new Error("File journal content is corrupt");
		const current = await this.#readExisting(absolute);
		const currentHash = current === null ? null : hash(current);
		if (currentHash === mutation.after) return;
		if (currentHash !== mutation.before)
			throw new ToolRejection("file_write_conflict", `${mutation.path} changed after the action was prepared`);
		if (bytes === null) {
			await unlink(absolute);
		} else {
			await mkdir(dirname(absolute), { recursive: true });
			await this.#confine(mutation.path, true);
			const temporary = `${absolute}.suiming-${randomUUID()}.tmp`;
			try {
				const file = await open(temporary, "wx", 0o600);
				try {
					await file.writeFile(bytes);
					await file.sync();
				} finally {
					await file.close();
				}
				signal?.throwIfAborted();
				await this.#confine(mutation.path, true);
				const latest = await this.#readExisting(absolute);
				if ((latest === null ? null : hash(latest)) !== mutation.before)
					throw new ToolRejection("file_write_conflict", mutation.path);
				await rename(temporary, absolute);
			} finally {
				await unlink(temporary).catch((error: unknown) => {
					if (!missing(error)) throw error;
				});
			}
		}
		const directory = await open(dirname(absolute), constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}

	async writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): Promise<void> {
		await this.applyMutation(await this.prepareWrite(path, content), signal);
	}

	async #readExisting(path: string, logical = path): Promise<Uint8Array | null> {
		try {
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				return await file.readFile();
			} finally {
				await file.close();
			}
		} catch (error) {
			if (missing(error)) return null;
			throw directoryRejection(logical, error) ?? error;
		}
	}
}
