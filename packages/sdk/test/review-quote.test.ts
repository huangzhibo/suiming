import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewQuote, reviewQuoteFragments } from "../src/index.js";

test("审稿引文：有引号取引号内原文；没有引号取规范化后 8 字以上的句子；都没有为空", () => {
	assert.deepEqual(reviewQuoteFragments("结尾只有“他没有喊”，缺少一次有阻力的身体动作。"), {
		quoted: true,
		fragments: ["他没有喊"],
	});
	assert.deepEqual(reviewQuoteFragments("短。军杖落到第三十下，黄盖咬住了衣角。"), {
		quoted: false,
		fragments: ["军杖落到第三十下，黄盖咬住了衣角"],
	});
	// 句子长短按规范化之后算：审稿页与 submit_review 曾一边量原文、一边量规范化后的文本。
	assert.deepEqual(reviewQuoteFragments("黄 盖 咬 住 了 衣 角。"), { quoted: false, fragments: [] });
	assert.equal(normalizeReviewQuote("「他 知道」‘曹操’"), "他知道曹操");
});
