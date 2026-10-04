import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LocalCommandOutput } from "@suiming/sdk";
import { parseMarkdownDocument, parseYaml, sha256Buffer } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { validateOpenPackagePath } from "../artifact/open-package.js";
import { classifyOpenStoryDirectoryFile } from "../artifact/open-story-directory.js";
import { ConfinedExecutionEnv } from "../harness/confined-env.js";
import { ToolRejection } from "../harness/tool.js";
import { LocalProjectLock } from "./project-lock.js";

type Entry = LocalCommandOutput<"workspace.files">["entries"][number];
const textExtension =
	/\.(?:md|markdown|txt|ya?ml|json|jsonl|toml|csv|tsv|xml|html|css|js|ts|tsx|jsx|svg|ini|cfg|log|sh)$/iu;
function visible(path: string): boolean {
	if (path.split("/").some((part) => part === ".suiming" || part === ".git")) return false;
	try {
		const kind = classifyOpenStoryDirectoryFile(path);
		return kind !== "private" && kind !== "temporary";
	} catch {
		return true;
	}
}
function classify(path: string): Pick<Entry, "classification" | "diagnostic"> {
	validateOpenPackagePath(path);
	if (!visible(path)) throw new ArtifactError("invalid_file_path", "该路径不属于作者文件目录");
	try {
		const kind = classifyOpenStoryDirectoryFile(path);
		return { classification: kind === "story" ? kind : "auxiliary" };
	} catch (error) {
		return { classification: "invalid", diagnostic: error instanceof Error ? error.message : String(error) };
	}
}
// 作者的文件视图：host 接入目录对模型藏起来，对作者照常可见。
const environment = (root: string) =>
	new ConfinedExecutionEnv({ rootPath: root, policy: "read", readable: visible, hostAdapters: "visible" });

/** 列出磁盘条目而非 Artifact；错误留在对应条目，不中断其它目录。 */
export async function listProjectFiles(root: string): Promise<Entry[]> {
	const env = environment(root);
	const entries: Entry[] = [];
	async function walk(parent: string): Promise<void> {
		for (const name of await env.listDir(parent || ".")) {
			const path = parent ? `${parent}/${name}` : name;
			if (!visible(path)) continue;
			try {
				const stat = await lstat(join(root, path));
				const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
				const entry: Entry = {
					path,
					type,
					size: stat.size,
					...(type === "directory" ? { classification: "auxiliary" as const } : classify(path)),
				};
				if (type === "symlink") entry.diagnostic = "符号链接不作为作品文件打开";
				entries.push(entry);
				if (type === "directory") {
					try {
						await walk(path);
					} catch (error) {
						entry.diagnostic = error instanceof Error ? error.message : String(error);
					}
				}
			} catch (error) {
				entries.push({
					path,
					type: "file",
					size: 0,
					classification: "invalid",
					diagnostic: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	await walk("");
	return entries;
}

/** 与系统应用交接前也验证整个路径；不通过 reveal/open 绕过根目录限制。 */
export async function resolveProjectFile(root: string, path: string): Promise<string> {
	classify(path);
	await environment(root).listDir(dirname(path));
	const stat = await lstat(join(root, path));
	if (stat.isSymbolicLink()) throw new ArtifactError("invalid_file_path", "不能打开符号链接");
	return join(root, path);
}
type FileView = LocalCommandOutput<"workspace.file.read">;

function missing(error: unknown): boolean {
	return (
		(error as NodeJS.ErrnoException)?.code === "ENOENT" ||
		(error instanceof ToolRejection && error.code === "file_not_found")
	);
}

/** 还没写的作品文件（如未写正文的 text/<beat>.md）：空内容、sha256 为 null，保存时新建。 */
function absentStoryFile(path: string, classification: Pick<Entry, "classification">, writable: boolean): FileView {
	return { path, content: "", sha256: null, size: 0, textual: true, writable, ...classification };
}

/** 文件字节 → 窗口看到的样子：是否文本、作品文件的格式诊断。工作目录与已提交版本走同一份。 */
function fileView(
	path: string,
	bytes: Uint8Array,
	classification: Pick<Entry, "classification" | "diagnostic">,
	writable: boolean,
): FileView {
	let content = "";
	let textual =
		textExtension.test(path) ||
		!path.split("/").at(-1)?.includes(".") ||
		path.split("/").at(-1)?.startsWith(".") === true;
	if (textual) {
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			textual = !content.includes("\0");
		} catch {
			textual = false;
		}
	}
	let diagnostic = classification.diagnostic;
	if (textual && classification.classification === "story") {
		try {
			if (path.endsWith(".md")) parseMarkdownDocument(content, path);
			else if (/\.ya?ml$/u.test(path)) parseYaml(content, path);
		} catch (error) {
			diagnostic = error instanceof Error ? error.message : String(error);
		}
	}
	return {
		path,
		content: textual ? content : "",
		sha256: sha256Buffer(bytes),
		size: bytes.length,
		textual,
		writable: writable && textual,
		...classification,
		...(diagnostic ? { diagnostic } : {}),
		...(!textual ? { diagnostic: "当前编辑器不支持此文件的文本编辑，可在系统应用中打开。" } : {}),
	};
}

export async function readProjectFile(root: string, path: string): Promise<FileView> {
	const classification = classify(path);
	let absolute: string;
	try {
		absolute = await resolveProjectFile(root, path);
	} catch (error) {
		if (!missing(error)) throw error;
		if (classification.classification === "story") return absentStoryFile(path, classification, true);
		throw new ArtifactError("file_not_found", `文件不存在：${path}`);
	}
	const stat = await lstat(absolute);
	if (!stat.isFile()) throw new ArtifactError("invalid_file_path", "请选择一个文件");
	// 不把大文件或不支持的二进制内容传入 renderer。
	if (stat.size > 4 * 1024 * 1024)
		return {
			path,
			content: "",
			sha256: null,
			size: stat.size,
			textual: false,
			writable: false,
			...classification,
			diagnostic: "此文件超过 4 MB，请使用系统应用打开。",
		};
	return fileView(path, await environment(root).readBinaryFile(path), classification, true);
}

/** 已提交版本里的一个文件，只读。版本里没有它时回空内容。 */
export function revisionFileView(path: string, bytes: Uint8Array | undefined): FileView {
	const classification = classify(path);
	return bytes === undefined
		? absentStoryFile(path, classification, false)
		: fileView(path, bytes, classification, false);
}

/** 与作品编辑复用锁、CAS 和原子替换；目录 codec 仍独立决定提交范围。 */
export async function saveProjectFile(
	root: string,
	input: { path: string; content: string; expectedSHA: string | null },
) {
	const lock = await LocalProjectLock.acquire(root, { waitMs: 5000 });
	try {
		const current = await readProjectFile(root, input.path);
		if (!current.writable) throw new ArtifactError("file_write_forbidden", "该文件仅供查看");
		if (current.sha256 !== input.expectedSHA)
			throw new ArtifactError("checkout_edit_conflict", "文件已被外部修改；请比较差异后再保存");
		const env = new ConfinedExecutionEnv({
			rootPath: root,
			policy: "write",
			readable: visible,
			hostAdapters: "visible",
			writable: (path) => path === input.path,
		});
		const mutation = await env.prepareWrite(input.path, input.content);
		if (mutation.before !== input.expectedSHA)
			throw new ArtifactError("checkout_edit_conflict", "文件已被外部修改；请比较差异后再保存");
		await env.applyMutation(mutation);
		return { path: input.path, content: input.content, sha256: mutation.after };
	} finally {
		await lock.release();
	}
}
