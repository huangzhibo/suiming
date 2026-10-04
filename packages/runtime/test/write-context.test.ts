import assert from "node:assert/strict";
import test from "node:test";
import { compileWriteContext } from "../src/harness/index.js";
import { artifactIdentityKey, candidateFromOpenStoryFiles, designClosurePaths } from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();

/**
 * 样例作品加两样东西：一份 world/core（全书公理，Story Language 不要求 Beat 引用它），一个只出现在 beat-0001
 * 硬状态变化里、refs 没写的人物阚泽（他替黄盖过江送降书）。
 */
function workWithCoreAndStateOnlyCharacter() {
	const files = sampleWorkFiles().map((file) =>
		file.path === "outline/story/vol-0001/beat-0001.md"
			? {
					...file,
					bytes: encoder.encode(
						new TextDecoder()
							.decode(file.bytes)
							.replace("    黄盖.location: 赤壁\n", "    黄盖.location: 赤壁\n    阚泽.location: 赤壁\n"),
					),
				}
			: file,
	);
	const markdown = (path: string, text: string) => ({
		path,
		mediaType: "text/markdown; charset=utf-8",
		bytes: encoder.encode(text),
	});
	files.push(
		markdown("world/core.md", "# 汉末天下\n\n汉室名义仍在，曹操挟天子以令诸侯；孙刘两家只能靠盟约抵挡。\n"),
		markdown("world/characters/阚泽.md", "---\nname: 阚泽\n---\n江东参谋，胆大口利，替黄盖过江向曹操献降书。\n"),
	);
	return candidateFromOpenStoryFiles(files, "write-context-test");
}

test("Write Context 带上 world/core 与只出现在本节硬状态变化里的人物", () => {
	const candidate = workWithCoreAndStateOnlyCharacter();
	const context = compileWriteContext(candidate, "beat-0001");
	assert.match(context.text, /### world core（world\/core\.md，全书公理）\n# 汉末天下/u);
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
