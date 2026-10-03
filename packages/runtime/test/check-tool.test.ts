import assert from "node:assert/strict";
import test from "node:test";
import { candidateFromStoryFiles, formatCheck } from "../src/index.js";
import { sampleWorkFiles, sampleWorkText } from "./sample-work.js";

const encoder = new TextEncoder();

/** 样例作品，按路径替换或追加文件。 */
function candidate(overrides: Record<string, string> = {}) {
	const files = sampleWorkFiles().filter((file) => !(file.path in overrides));
	for (const [path, text] of Object.entries(overrides))
		files.push({
			path,
			mediaType: path.endsWith(".yaml") ? "application/yaml; charset=utf-8" : "text/markdown; charset=utf-8",
			bytes: encoder.encode(text),
		});
	return candidateFromStoryFiles("r1", files);
}
const BEAT_1 = "outline/story/vol-0001/beat-0001.md";
const BEAT_2 = "outline/story/vol-0001/beat-0002.md";
const unresolved = { [BEAT_2]: sampleWorkText(BEAT_2).replace("contracts:\n  resolve: [诈降]\n", "") };

test("check 工具：没有问题才说 PASSED", () => {
	assert.equal(formatCheck(candidate()), "PASSED");
});

test("check 工具：设计层错误不拦提交，但不再说 PASSED——说 ISSUES 并逐条列出", () => {
	// 2026-10-02 之前这里说 PASSED：formatCheck 只复用提交闸，Contract 没兑现、秘密先揭示后声明这类
	// 设计层错误不拦提交，于是 Agent 看到「通过」，而 CLI 与桌面对同一份候选说「未通过：设计」。
	const result = formatCheck(candidate(unresolved));
	const lines = result.split("\n");
	assert.match(lines[0] ?? "", /^ISSUES：可以提交，但有 1 处问题要修/u);
	assert.equal(
		lines[1],
		"- error: outline/contracts/诈降.md：StoryContract 诈降：到期限 beat-0002 还没有兑现；提示：在 beat-0002 或更早的 StoryBeat 里写 contracts.resolve: [诈降]",
	);
});

test("check 工具：已有正文的问题与设计问题一起列出，正文点名 Beat；还没写的正文不算问题", () => {
	const result = formatCheck(candidate({ ...unresolved, "text/beat-0001.md": "" }));
	assert.match(result, /^ISSUES：可以提交，但有 2 处问题要修/u);
	assert.match(result, /\n- error: beat-0001 正文（empty_text）：text\/beat-0001\.md 是空的/u);
	assert.doesNotMatch(result, /missing_text|beat-0002 正文/u, "beat-0002 还没有正文，不是问题");
});

test("check 工具：提交会被拒的问题照旧是 FAILED，带全部诊断", () => {
	const result = formatCheck(
		candidate({ [BEAT_1]: sampleWorkText(BEAT_1).replace("character: [黄盖]", "character: [黄盖, 不存在]") }),
	);
	assert.match(result, /^FAILED missing_context_reference: /u);
	assert.match(result, /\n- outline\/story\/vol-0001\/beat-0001\.md#\/frontmatter\/refs\/character\/1：找不到引用/u);
});

test("check 工具：全书未完待续时，已建立未到期的 Contract 只作说明，仍是 PASSED", () => {
	const result = formatCheck(
		candidate({
			...unresolved,
			"outline/story/index.yaml": `schema_version: 2\nopen_ended: true\n${sampleWorkText("outline/story/index.yaml").replace("schema_version: 2\n", "")}`,
			"outline/contracts/诈降.md": sampleWorkText("outline/contracts/诈降.md").replace(
				"deadline: beat-0002",
				"deadline: book_end",
			),
		}),
	);
	assert.equal(result, "PASSED\n未闭合但尚未到期的 Contract：诈降");
});
