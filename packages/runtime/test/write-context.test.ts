import assert from "node:assert/strict";
import test from "node:test";
import { compileWriteContext } from "../src/harness/index.js";
import { artifactIdentityKey, candidateFromOpenStoryFiles, designClosurePaths } from "../src/index.js";
import { sampleWorkFiles, sampleWorkText } from "./sample-work.js";

/** 样例作品里有 world/core（全书公理，不要求 Beat 引用）与只出现在 beat-0001 硬状态变化里的阚泽。 */
function workWithCoreAndStateOnlyCharacter() {
	return candidateFromOpenStoryFiles(sampleWorkFiles(), "write-context-test");
}

test("Write Context 带上 world/core 与只出现在本节硬状态变化里的人物", () => {
	const candidate = workWithCoreAndStateOnlyCharacter();
	const context = compileWriteContext(candidate, "beat-0001");
	assert.match(context.text, /### world core（world\/core\.md，全书公理）\n# 赤壁之战的天下/u);
	assert.match(context.text, /### character 阚泽（world\/characters\/阚泽\.md，只出现在本节的硬状态变化里）/u);
	// refs 里写了的人物排在前面，只在 changes 里出现的跟在后面。
	assert.ok(context.text.indexOf("### character 黄盖") < context.text.indexOf("### character 阚泽"));
	// 第二节不碰阚泽，不带他的人物档（硬状态里照样有他在第一节之后的位置）；world/core 每一节都带。
	const second = compileWriteContext(candidate, "beat-0002");
	assert.doesNotMatch(second.text, /### character 阚泽/u);
	assert.match(second.text, /### world core/u);
});

test("Writer 读到的 Design 就是正文时效比较的 Design 闭包，一个文件不多不少", () => {
	// 两边不一致的后果：写的时候没读过的文件改了，正文却被标成「设计已变」；读过的改了却不标。
	const candidate = workWithCoreAndStateOnlyCharacter();
	const pathOf = new Map(candidate.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]));
	for (const beatId of ["beat-0001", "beat-0002"]) {
		const read = compileWriteContext(candidate, beatId)
			.artifacts.filter((identity) => !["story-text", "style-evidence"].includes(identity.kind))
			.map((identity) => pathOf.get(artifactIdentityKey(identity))?.path)
			.sort();
		const closure = designClosurePaths(candidate, beatId).filter((path) => path !== "outline/story/index.yaml");
		assert.deepEqual(read, closure, beatId);
	}
});

test("Write Context 标出本节 Design 与前文各节正文、Design 的字数：写手照前文的比例定篇幅，不照上一节的长度", () => {
	// 2026-10-18 斗破留出：只有第一节接原作前文，篇幅是原作的 1.03–1.30 倍；之后接 Agent 自己写长了的上一节，开新章的节
	// 也到 1.7–1.8 倍。写手看得到上一节多长，看不到那一节本来要写多少事（Write Context 不装别的节的 Design）。
	const previousText = "## 第一章 苦肉计\n\n黄盖出列。\n\n周瑜拍案：“打！”";
	const files = [
		...sampleWorkFiles(),
		{
			path: "text/beat-0001.md",
			mediaType: "text/markdown; charset=utf-8",
			bytes: new TextEncoder().encode(previousText),
		},
	];
	const candidate = candidateFromOpenStoryFiles(files, "write-context-length");
	const chars = (text: string) => [...text.replace(/\s/gu, "")].length;
	const designBody = (path: string) => sampleWorkText(path).replace(/^---\n[\s\S]*?\n---\n/u, "");
	const context = compileWriteContext(candidate, "beat-0002");
	assert.match(
		context.text,
		new RegExp(`（顺序 2 / 2，[^）]*；Design ${chars(designBody("outline/story/vol-0001/beat-0002.md"))} 字）`, "u"),
	);
	assert.match(
		context.text,
		new RegExp(
			`### previous text/beat-0001\\.md（直接续写表面；正文 ${chars("黄盖出列。周瑜拍案：“打！”")} 字，这一节的 Design ${chars(designBody("outline/story/vol-0001/beat-0001.md"))} 字）`,
			"u",
		),
		"字数不算章题，与对照原作时的口径一样",
	);
});
