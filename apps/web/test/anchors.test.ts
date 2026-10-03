import assert from "node:assert/strict";
import test from "node:test";
import { anchorParagraphs, paragraphSpans, quotedFragments } from "../src/anchors.js";

const text = `# 第一场

军杖落到第三十下，黄盖咬住了衣角。他知道曹操的人就在辕门外看着。

- 要点一
- 要点二

> 引语一段

他没有喊。
`;

test("段号按 mdast paragraph 的文档顺序编，标题不算段，列表项与引语里的段落算", () => {
	const spans = paragraphSpans(text);
	assert.deepEqual(
		spans.map((span) => span.text),
		[
			"军杖落到第三十下，黄盖咬住了衣角。他知道曹操的人就在辕门外看着。",
			"要点一",
			"要点二",
			"引语一段",
			"他没有喊。",
		],
	);
	assert.equal(text.slice(spans[4]?.start, spans[4]?.end), "他没有喊。");
});

test("引文优先取引号内原文，没有引号时退回长句；空白与引号差异不影响命中", () => {
	assert.deepEqual(quotedFragments("结尾只有“他没有喊”，缺少一次有阻力的身体动作。"), ["他没有喊"]);
	assert.deepEqual(quotedFragments("短。军杖落到第三十下，黄盖咬住了衣角。"), ["军杖落到第三十下，黄盖咬住了衣角"]);
	assert.deepEqual(anchorParagraphs("结尾只有“他没有喊”，缺少一次有阻力的身体动作。", text), [4]);
	assert.deepEqual(anchorParagraphs("「他 知道曹操的人就在辕门外看着」写得太省。", text), [0]);
	assert.deepEqual(anchorParagraphs("整体节奏偏慢。", text), []);
	// 引文太短（少于 4 字）不锚，避免“黄盖”这类命中一切。
	assert.deepEqual(anchorParagraphs("“黄盖”", text), []);
});
