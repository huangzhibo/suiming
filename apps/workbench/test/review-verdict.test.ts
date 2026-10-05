import assert from "node:assert/strict";
import test from "node:test";
import { SUIM_CLI_COMMAND_DATA } from "@suiming/sdk";
import { verdictColor, verdictLabel, verdictTone } from "../src/review-verdict.js";

// 取值从 sdk 的审稿 schema 读，不手抄：Story Language 新增一种结论时这条测试要能发现。sdk 与 story 的取值一致
// 由 runtime 的 sdk-story-alignment.test 守（web 不依赖 @suiming/story）。
const VERDICTS = (
	SUIM_CLI_COMMAND_DATA["review.list"].properties.reviews.items.properties.verdict as unknown as {
		anyOf: { const: string }[];
	}
).anyOf.map((item) => item.const);

test("每种审稿结论都有中文说法与非灰色的色调", () => {
	assert.ok(VERDICTS.length >= 4);
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
