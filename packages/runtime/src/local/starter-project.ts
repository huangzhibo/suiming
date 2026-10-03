import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ArtifactError } from "../artifact/errors.js";

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function writeText(root: string, relative: string, text: string, written: string[]): Promise<void> {
	const path = join(root, relative);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, { encoding: "utf8", flag: "wx" });
	written.push(relative);
}
const STORY_INDEX_PATH = "outline/story/index.yaml";
const BOOK_INTENT_PATH = "intent/book.md";
const GENESIS_STORY_INDEX = "schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 第一卷\n    beat_ids: []\n";

/**
 * 从空目录开始一部作品：写最小可提交的 Design（一个空卷的 Story index）和可选的初始 Intent。
 * 目录已经是 Open Story Directory 时不动 Design；只有 `intent/book.md` 不存在时才写 Intent。
 */
export async function scaffoldOpenStoryDirectory(
	root: string,
	options: { intent?: string } = {},
	written: string[] = [],
): Promise<string[]> {
	const intent = options.intent?.trim();
	if (intent !== undefined && intent.length > 0 && (await readText(join(root, BOOK_INTENT_PATH))) !== undefined) {
		throw new ArtifactError("intent_already_exists", `${BOOK_INTENT_PATH} 已经存在，直接编辑它即可`);
	}
	await mkdir(root, { recursive: true });
	if ((await readText(join(root, STORY_INDEX_PATH))) === undefined) {
		await writeText(root, STORY_INDEX_PATH, GENESIS_STORY_INDEX, written);
	}
	if (intent !== undefined && intent.length > 0) {
		await writeText(root, BOOK_INTENT_PATH, `${intent}\n`, written);
	}
	return written;
}
