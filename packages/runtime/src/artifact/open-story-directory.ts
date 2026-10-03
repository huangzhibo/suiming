import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { ArtifactError } from "./errors.js";
import { type OpenPackageFile, validateOpenPackagePath } from "./open-package.js";
import { storyPackageCodec } from "./story-package-codec.js";

const STORY_ROOTS = new Set(["intent", "outline", "world", "reference", "text", "source", "release", "review"]);
const PRIVATE_ROOTS = new Set([".git", ".suiming"]);

/** 作品目录里只有一种作品文件：Story artifact。审稿与 Source 笔记也是普通 artifact，没有单独的 evidence 类。 */
export type OpenStoryDirectoryFileKind = "story";
/**
 * `unrecognized`：落在 Story 根下、Story Language 却不认识的路径（如 `world/secrets/x.md`）。它不是仓库辅助文件——
 * 写的人想让它进作品——所以不能静默跳过：扫描照常完成（状态、diff、事件、桌面都要读得出来），候选带上它，
 * Checker 在 check / commit 时点名拦下。2026-10-01 斗破那一轮之前扫描在这里直接抛错，一个放错的文件让整个
 * 作品读不出来，连 `session list` 都失败，turn 也随之掀掉。
 */
export type OpenStoryDirectoryIgnoredKind = "private" | "temporary" | "repository-auxiliary" | "unrecognized";

export interface OpenStoryDirectoryIgnoredEntry {
	path: string;
	kind: OpenStoryDirectoryIgnoredKind;
}

export interface OpenStoryDirectoryScan {
	files: OpenPackageFile[];
	ignored: OpenStoryDirectoryIgnoredEntry[];
}

export function unrecognizedPaths(ignored: readonly OpenStoryDirectoryIgnoredEntry[]): string[] {
	return ignored.filter((entry) => entry.kind === "unrecognized").map((entry) => entry.path);
}

/** 作者或模型都能自己改的错误：点名路径，说清该怎么放。check / commit / init 共用这一句。 */
export function unrecognizedStoryPathsError(paths: readonly string[]): ArtifactError {
	return new ArtifactError(
		"unsupported_story_package_path",
		`Story Language 不认识这些路径，它们进不了版本：${paths.join("、")}。作品文件要放在 Story Language 规定的路径上（格式查 story_guide 或 suim design guide）；不属于作品的文件挪出 ${[...STORY_ROOTS].join("、")} 这几个目录。`,
	);
}

function rootName(path: string): string {
	return path.split("/", 1)[0] as string;
}

function isReservedPath(path: string): boolean {
	return STORY_ROOTS.has(rootName(path));
}

function isTemporaryName(name: string): boolean {
	return (
		name === ".DS_Store" ||
		name.startsWith("._") ||
		name.startsWith(".#") ||
		(/^#.*#$/u.test(name) && name.length > 2) ||
		name.endsWith("~") ||
		/\.(?:swp|swo|tmp|temp)$/iu.test(name)
	);
}

/** 路径到 mediaType 的唯一映射。git 支持的 Canon 存储从 tree 读文件时用同一份，不另写一套。 */
export function mediaTypeForPath(path: string): string {
	const extension = extname(path).toLowerCase();
	switch (extension) {
		case ".md":
			return "text/markdown; charset=utf-8";
		case ".yaml":
		case ".yml":
			return "application/yaml; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".txt":
			return "text/plain; charset=utf-8";
		case ".csv":
			return "text/csv; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".pdf":
			return "application/pdf";
		case ".epub":
			return "application/epub+zip";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		default:
			return "application/octet-stream";
	}
}

export function classifyOpenStoryDirectoryFile(
	path: string,
): OpenStoryDirectoryFileKind | OpenStoryDirectoryIgnoredKind {
	validateOpenPackagePath(path);
	const root = rootName(path);
	if (PRIVATE_ROOTS.has(root)) return "private";
	if (isTemporaryName(path.split("/").at(-1) as string)) return "temporary";
	if (STORY_ROOTS.has(root)) {
		storyPackageCodec.identityForPath(path);
		return "story";
	}
	return "repository-auxiliary";
}

/** mtime 离读的时刻不到这么久的文件不复用。FAT 的时间戳是 2 秒一格。 */
const RACY_WINDOW_NS = 3_000_000_000n;

/**
 * 按文件状态（inode、大小、mtime、ctime，纳秒）复用上一次读到的字节，给 turn 里每 100ms 刷一次的
 * `workspace.show` 用：斗破 259 个文件，整份重读一次 25ms，只看状态 4ms。状态没变就返回同一个字节对象，
 * 下游可以按对象记住解析结果。刚写过的文件不复用——粗粒度时间戳的文件系统上，同一刻内的两次写入
 * 状态完全相同（git 叫它 racy git）。检查、提交与 turn 开场的扫描不走这里，照旧整份重读：
 * 视图旧一拍下一次就纠正，提交读到旧字节就坏作品。
 */
export class OpenStoryDirectoryCache {
	#entries = new Map<string, { stamp: string; bytes: Uint8Array }>();

	async read(absolutePath: string, path: string): Promise<Uint8Array> {
		const stat = await lstat(absolutePath, { bigint: true });
		const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
		const cached = this.#entries.get(path);
		if (cached?.stamp === stamp) return cached.bytes;
		const bytes = new Uint8Array(await readFile(absolutePath));
		if (BigInt(Date.now()) * 1_000_000n - stat.mtimeNs > RACY_WINDOW_NS) this.#entries.set(path, { stamp, bytes });
		else this.#entries.delete(path);
		return bytes;
	}

	/** 一次扫描之后只留这次还在的路径，删掉的文件不常驻内存。 */
	retain(paths: ReadonlySet<string>): void {
		for (const path of this.#entries.keys()) if (!paths.has(path)) this.#entries.delete(path);
	}
}

export async function readOpenStoryDirectory(
	rootPath: string,
	cache?: OpenStoryDirectoryCache,
): Promise<OpenStoryDirectoryScan> {
	let rootStat: Awaited<ReturnType<typeof lstat>>;
	try {
		rootStat = await lstat(rootPath);
	} catch (error) {
		throw new ArtifactError("story_directory_not_found", `读不到作品目录 ${rootPath}：${(error as Error).message}`);
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new ArtifactError("invalid_story_directory", `作品目录必须是真实目录，不能是文件或符号链接：${rootPath}`);
	}

	const files: OpenPackageFile[] = [];
	const ignored: OpenStoryDirectoryIgnoredEntry[] = [];

	async function visit(absoluteDirectory: string, logicalDirectory: string): Promise<void> {
		const entries = await readdir(absoluteDirectory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = logicalDirectory.length === 0 ? entry.name : `${logicalDirectory}/${entry.name}`;
			const absolutePath = join(absoluteDirectory, entry.name);
			const root = rootName(path);
			const reserved = isReservedPath(path);

			if (PRIVATE_ROOTS.has(root)) {
				ignored.push({ path, kind: "private" });
				continue;
			}
			if (logicalDirectory.length === 0 && !reserved) {
				ignored.push({ path, kind: isTemporaryName(entry.name) ? "temporary" : "repository-auxiliary" });
				continue;
			}
			if (entry.isSymbolicLink()) {
				throw new ArtifactError(
					"unsafe_story_directory_symlink",
					`Open Story Directory does not follow symlinks in reserved paths: ${path}`,
				);
			}
			if (isTemporaryName(entry.name)) {
				ignored.push({ path, kind: "temporary" });
				continue;
			}
			if (entry.isDirectory()) {
				await visit(absolutePath, path);
				continue;
			}
			if (!entry.isFile()) {
				throw new ArtifactError("unsupported_story_directory_entry", `Unsupported directory entry: ${path}`);
			}

			let kind: OpenStoryDirectoryFileKind | OpenStoryDirectoryIgnoredKind;
			try {
				kind = classifyOpenStoryDirectoryFile(path);
			} catch (error) {
				if (!(error instanceof ArtifactError && error.code === "unsupported_story_package_path")) throw error;
				kind = "unrecognized";
			}
			if (kind === "story") {
				files.push({
					path,
					mediaType: mediaTypeForPath(path),
					bytes: cache ? await cache.read(absolutePath, path) : new Uint8Array(await readFile(absolutePath)),
				});
			} else {
				ignored.push({ path, kind });
			}
		}
	}

	await visit(rootPath, "");
	cache?.retain(new Set(files.map((file) => file.path)));
	files.sort((left, right) => left.path.localeCompare(right.path));
	ignored.sort((left, right) => left.path.localeCompare(right.path));
	return { files, ignored };
}

export async function materializeOpenStoryDirectorySnapshot(
	rootPath: string,
	files: readonly OpenPackageFile[],
): Promise<void> {
	try {
		const rootStat = await lstat(rootPath);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new ArtifactError("invalid_story_directory", `导出目标必须是真实目录：${rootPath}`);
		}
		if ((await readdir(rootPath)).length > 0) {
			throw new ArtifactError("story_directory_not_empty", `导出目标必须是空目录：${rootPath}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(rootPath, { recursive: true });
	}

	const paths = new Set<string>();
	for (const file of files) {
		if (classifyOpenStoryDirectoryFile(file.path) !== "story") {
			throw new ArtifactError(
				"unsupported_story_package_path",
				`Snapshot contains a non-package path: ${file.path}`,
			);
		}
		if (paths.has(file.path)) throw new ArtifactError("duplicate_logical_path", `Duplicate path: ${file.path}`);
		paths.add(file.path);
		const absolutePath = join(rootPath, file.path);
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, file.bytes, { flag: "wx" });
	}
}
