import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewDraft, SuimError } from "../src/index.js";

test("ReviewDraft 只保存可反驳的模型判断，不携带运行时绑定", () => {
	const draft = parseReviewDraft({
		verdict: "revise",
		summary: "人物选择缺少足以支撑结果的前因。",
		findings: [
			{
				severity: "major",
				anchor: { kind: "artifact", path: "outline/story/vol-0001/beat-0002.md" },
				issue: "李牧突然决定焚信。",
				evidence: "当前 Beat 只写了焚信结果，前一个 Beat 仍把保存密信作为唯一目标。",
				repairLayer: "design",
				suggestion: "补足使他主动选择不可恢复代价的触发与权衡。",
			},
		],
		uncovered: [],
		uncertainties: [],
	});
	assert.equal(draft.findings[0]?.repairLayer, "design");
	assert.equal("contextHash" in draft, false);
	assert.equal("task" in draft, false);
});

test("ReviewDraft verdict 与 finding 语义必须一致", () => {
	assert.throws(
		() =>
			parseReviewDraft({
				verdict: "pass",
				summary: "通过。",
				findings: [
					{
						severity: "minor",
						anchor: { kind: "artifact", path: "world/core.md" },
						issue: "仍有问题。",
						evidence: "证据。",
						repairLayer: "design",
					},
				],
				uncovered: [],
				uncertainties: [],
			}),
		(error: unknown) => error instanceof SuimError && error.code === "invalid_review_draft",
	);
	assert.throws(
		() =>
			parseReviewDraft({
				verdict: "insufficient_context",
				summary: "无法判断。",
				findings: [],
				uncovered: [],
				uncertainties: [],
			}),
		(error: unknown) => error instanceof SuimError && error.code === "invalid_review_draft",
	);
});

test("Review finding 只能锚定安全 artifact path 或有效 Source span", () => {
	assert.throws(
		() =>
			parseReviewDraft({
				verdict: "block",
				summary: "输入越界。",
				findings: [
					{
						severity: "blocker",
						anchor: { kind: "artifact", path: "../outside.md" },
						issue: "锚点越界。",
						evidence: "路径不属于作品包。",
						repairLayer: "source",
					},
				],
				uncovered: [],
				uncertainties: [],
			}),
		(error: unknown) => error instanceof SuimError && error.code === "invalid_review_draft",
	);
	const draft = parseReviewDraft({
		verdict: "block",
		summary: "材料证据不足。",
		findings: [
			{
				severity: "blocker",
				anchor: { kind: "source_span", sourceId: "原作", start: 10, end: 20 },
				issue: "抽取遗漏了转折。",
				evidence: "原文在该范围明确改变了人物决定。",
				repairLayer: "source",
			},
		],
		uncovered: [],
		uncertainties: [],
	});
	assert.equal(draft.findings[0]?.anchor.kind, "source_span");
});
