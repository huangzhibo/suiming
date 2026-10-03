import assert from "node:assert/strict";
import test from "node:test";
import { verdictColor, verdictLabel, verdictTone } from "../src/review-verdict.js";

// 与 packages/story/src/review.ts 的 REVIEW_VERDICTS 一致；web 不依赖 @suiming/story，这里照抄一份。
const VERDICTS = ["pass", "revise", "block", "insufficient_context"];

test("每种审稿结论都有中文说法与非灰色的色调", () => {
	for (const verdict of VERDICTS) {
		assert.notEqual(verdictLabel(verdict), verdict, verdict);
		assert.notEqual(verdictTone(verdict), "gray", verdict);
	}
});

// 故事轴曾自己判断一个不存在的 "reject"，block 结论于是画成琥珀色、和「需修订」分不开。
test("故事轴的审稿颜色与审稿页同源：阻断是红色", () => {
	assert.equal(verdictColor("block"), "var(--destructive)");
	assert.equal(verdictColor("pass"), "var(--success)");
	assert.equal(verdictColor("revise"), "var(--amber)");
	assert.equal(verdictColor("insufficient_context"), "var(--amber)");
});
