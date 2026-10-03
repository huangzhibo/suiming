import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * story-language/*.md 是 Story Language 语义的唯一真源。这里把它们生成为 @suiming/story 的常量：
 * Agent 经 story_guide 的 topic 读它，`suim init --agent` 把同一份写进作品仓给 host 读。
 * 2026-10-02 之前只有 CLI 的 host-files 嵌了一份，Agent 一个字也读不到——抽斗破时 Beat 写成速记、
 * 人物档写成编年、一个秘密都没声明，都是因为它只看得到字段形状。
 * `npm run check` 会核对生成物与真源一致；不要手改生成文件。
 */
const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "story-language");
const targetPath = resolve(root, "packages/story/src/story-language-docs.ts");

function normalize(text) {
	return text.replace(/\r\n/gu, "\n").trimEnd().concat("\n");
}

export function renderStoryLanguageModule(docs) {
	const entries = docs
		.map(
			(doc) =>
				`\t{ name: ${JSON.stringify(doc.name)}, topic: ${JSON.stringify(doc.topic)}, title: ${JSON.stringify(doc.title)}, text: ${JSON.stringify(doc.text)} },`,
		)
		.join("\n");
	return `// 由 scripts/generate-story-language.mjs 从 story-language/ 生成；不要手改，改真源后运行 npm run generate:story-language。

/** 一份 Story Language 语义文档：topic 是文件名去掉 .md 的小写，title 是正文第一个一级标题。 */
export interface StoryLanguageDoc {
	readonly name: string;
	readonly topic: string;
	readonly title: string;
	readonly text: string;
}

export const STORY_LANGUAGE_DOCS: readonly StoryLanguageDoc[] = Object.freeze([
${entries}
]);
`;
}

const docs = readdirSync(sourcePath)
	.filter((name) => name.endsWith(".md"))
	.sort()
	.map((name) => {
		const text = normalize(readFileSync(resolve(sourcePath, name), "utf8"));
		const title = /^#[ \t]+(.+?)[ \t]*$/mu.exec(text)?.[1];
		if (title === undefined) throw new Error(`story-language/${name} has no level-1 heading`);
		return { name, topic: name.replace(/\.md$/u, "").toLowerCase(), title, text };
	});
const rendered = renderStoryLanguageModule(docs);

if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(targetPath, "utf8");
	} catch {
		// 缺文件也算过期。
	}
	if (current !== rendered) {
		console.error("packages/story/src/story-language-docs.ts is stale; run npm run generate:story-language");
		process.exitCode = 1;
	} else {
		console.log("Story Language docs module matches story-language/.");
	}
} else {
	writeFileSync(targetPath, rendered);
	console.log(`Wrote ${targetPath}`);
}
