import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * strategies/story-constitution.md 是故事创作宪法的唯一真源；这里把它生成为 @suiming/story 的常量，
 * 版本是 markdown 内容的 sha256。宪法变化 → 版本变化 → 下一个 turn 冻结的绑定显示新版本。
 * `npm run check` 会核对生成物与真源一致；不要手改生成文件。
 */
const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "strategies/story-constitution.md");
const targetPath = resolve(root, "packages/story/src/constitution.ts");

export function renderConstitutionModule(markdown) {
	const normalized = markdown.replace(/\r\n/gu, "\n").trimEnd().concat("\n");
	const version = `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
	return `// 由 scripts/generate-constitution.mjs 从 strategies/story-constitution.md 生成；不要手改，改真源后运行 npm run generate:constitution。

/** 故事创作宪法：版本是真源 markdown 的 sha256，进入使用它的那个 turn 冻结的绑定。 */
export const STORY_CONSTITUTION = Object.freeze({
	version: ${JSON.stringify(version)},
	markdown: ${JSON.stringify(normalized)},
});
`;
}

const rendered = renderConstitutionModule(readFileSync(sourcePath, "utf8"));
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(targetPath, "utf8");
	} catch {
		// 缺文件也算过期。
	}
	if (current !== rendered) {
		console.error("packages/story/src/constitution.ts is stale; run npm run generate:constitution");
		process.exitCode = 1;
	} else {
		console.log("Story constitution module matches strategies/story-constitution.md.");
	}
} else {
	writeFileSync(targetPath, rendered);
	console.log(`Wrote ${targetPath}`);
}
