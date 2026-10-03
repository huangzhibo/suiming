import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * integrations/ 是 host adapter 文件的唯一真源：共享 Skill 与 Codex 自定义 agent。这里把它们生成为 @suiming/cli 的常量，
 * 随 Skill 一起装进作品仓的 Story Language 文档不在这里：它和 Agent 读的是同一份 @suiming/story 的 STORY_LANGUAGE_DOCS
 * （scripts/generate-story-language.mjs），以前这里另嵌一份，Agent 那边却一个字也没有。
 * 让 `suim init --agent` 与 `suim update --agent` 在任何安装位置都能把它们写进作品仓，不依赖开发仓路径。
 * Skill 版本是 markdown 内容的 sha256。
 * `npm run check` 会核对生成物与真源一致；不要手改生成文件。
 */
const root = resolve(import.meta.dirname, "..");
const skillPath = resolve(root, "integrations/shared/suiming/SKILL.md");
const codexAgentsPath = resolve(root, "integrations/codex/agents");
const targetPath = resolve(root, "apps/cli/src/host-files.ts");

function normalize(text) {
	return text.replace(/\r\n/gu, "\n").trimEnd().concat("\n");
}

function fileEntries(files) {
	return files
		.map((file) => `\t\t{ name: ${JSON.stringify(file.name)}, text: ${JSON.stringify(file.text)} },`)
		.join("\n");
}

export function renderHostFilesModule(skill, codexAgents) {
	const version = `sha256:${createHash("sha256").update(skill, "utf8").digest("hex")}`;
	return `// 由 scripts/generate-host-files.mjs 从 integrations/ 生成；不要手改，改真源后运行 npm run generate:host-files。

/** host adapter 文件：共享 Skill（版本是 markdown 的 sha256）与 Codex 项目级自定义 agent。Story Language 文档取 @suiming/story 的 STORY_LANGUAGE_DOCS。 */
export const HOST_FILES = Object.freeze({
	skill: { version: ${JSON.stringify(version)}, markdown: ${JSON.stringify(skill)} },
	codexAgents: [
${fileEntries(codexAgents)}
	],
});
`;
}

const skill = normalize(readFileSync(skillPath, "utf8"));
const codexAgents = readdirSync(codexAgentsPath)
	.filter((name) => name.endsWith(".toml"))
	.sort()
	.map((name) => ({ name, text: normalize(readFileSync(resolve(codexAgentsPath, name), "utf8")) }));
const rendered = renderHostFilesModule(skill, codexAgents);

if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(targetPath, "utf8");
	} catch {
		// 缺文件也算过期。
	}
	if (current !== rendered) {
		console.error("apps/cli/src/host-files.ts is stale; run npm run generate:host-files");
		process.exitCode = 1;
	} else {
		console.log("Host files module matches integrations/.");
	}
} else {
	writeFileSync(targetPath, rendered);
	console.log(`Wrote ${targetPath}`);
}
