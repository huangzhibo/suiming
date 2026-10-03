import assert from "node:assert/strict";
import test from "node:test";
import { anchorParagraphs, paragraphSpans, quotedFragments } from "../src/anchors.js";

const text = `# 第一场

黄盖推开赤壁的门，霉味先于灯光涌出来。他知道匣子在哪一层。

- 要点一
- 要点二

> 引语一段

他还是伸手取了。
`;

test("段号按 mdast paragraph 的文档顺序编，标题不算段，列表项与引语里的段落算", () => {
	const spans = paragraphSpans(text);
	assert.deepEqual(
		spans.map((span) => span.text),
		[
			"黄盖推开赤壁的门，霉味先于灯光涌出来。他知道匣子在哪一层。",
			"要点一",
			"要点二",
			"引语一段",
			"他还是伸手取了。",
		],
	);
	assert.equal(text.slice(spans[4]?.start, spans[4]?.end), "他还是伸手取了。");
});

test("引文优先取引号内原文，没有引号时退回长句；空白与引号差异不影响命中", () => {
	assert.deepEqual(quotedFragments("结尾只有“他还是伸手取了”，缺少一次有阻力的身体动作。"), ["他还是伸手取了"]);
	assert.deepEqual(quotedFragments("短。黄盖推开赤壁的门，霉味先于灯光涌出来。"), [
		"黄盖推开赤壁的门，霉味先于灯光涌出来",
	]);
	assert.deepEqual(anchorParagraphs("结尾只有“他还是伸手取了”，缺少一次有阻力的身体动作。", text), [4]);
	assert.deepEqual(anchorParagraphs("「他 知道匣子在哪一层」写得太省。", text), [0]);
	assert.deepEqual(anchorParagraphs("整体节奏偏慢。", text), []);
	// 引文太短（少于 4 字）不锚，避免“的门”这类命中一切。
	assert.deepEqual(anchorParagraphs("“的门”", text), []);
});
