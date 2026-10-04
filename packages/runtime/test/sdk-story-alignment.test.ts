import assert from "node:assert/strict";
import test from "node:test";
import { SUIM_CLI_COMMAND_DATA } from "@suiming/sdk";
import { REVIEW_LAYERS, REVIEW_VERDICTS } from "@suiming/story";

// sdk 不依赖 story（要给浏览器端用），审稿的取值只能各写一份；runtime 两边都依赖，在这里对一次账。
const literals = (schema: unknown) =>
	(schema as { anyOf: { const: unknown }[] }).anyOf.map((item) => item.const).sort();

test("sdk 的审稿 verdict 与 layer 和 Story Language 的取值一致", () => {
	const review = SUIM_CLI_COMMAND_DATA["review.list"].properties.reviews.items.properties;
	assert.deepEqual(literals(review.verdict), [...REVIEW_VERDICTS].sort());
	assert.deepEqual(literals(review.layer), [...REVIEW_LAYERS].sort());
});
