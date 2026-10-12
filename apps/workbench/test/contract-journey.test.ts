import assert from "node:assert/strict";
import test from "node:test";
import { contractExcerpt, contractJourney } from "../src/axis/contract-journey.js";
import type { AxisModel, ContractLane } from "../src/axis/layout.js";

const model = {
	beats: Array.from({ length: 40 }, (_, ordinal) => ({
		id: `beat-${40 - ordinal}`,
		ordinal,
		volumeId: "v1",
		title: `情节 ${ordinal}`,
		path: `beat-${40 - ordinal}.md`,
		text: "none",
		textPath: undefined,
		dirty: false,
	})),
} as AxisModel;
const lane: ContractLane = {
	id: "期待",
	title: "期待",
	path: "期待.md",
	open: [1],
	advance: [],
	resolve: [5],
	late: [],
	deadline: "beat-35",
	deadlineIndex: 5,
	subjects: [],
};

test("期待路径按故事顺序合并同节阶段，期限合并到事件，回应后推进不改排到回应之前", () => {
	const journey = contractJourney(model, { ...lane, advance: [7, 3, 3, 5], late: [7] });
	assert.deepEqual(
		journey.map((entry) => entry.beat.ordinal),
		[1, 3, 5, 7],
	);
	assert.deepEqual(journey[2]?.phases, ["advance", "resolve"]);
	assert.equal(journey[2]?.deadline, true);
	assert.deepEqual(journey[3]?.warnings, ["回应后仍有推进，请核对"]);
	assert.equal(journey[2]?.warnings.length, 0);
});

test("期待路径覆盖零、一和大量记录，不制造缺失阶段或期限事件；超期回应有明确提示", () => {
	assert.deepEqual(contractJourney(model, { ...lane, open: [], resolve: [] }), []);
	assert.equal(contractJourney(model, { ...lane, resolve: [] }).length, 1);
	const dense = contractJourney(model, { ...lane, advance: model.beats.map((b) => b.ordinal) });
	assert.equal(dense.length, 40);
	const overdue = contractJourney(model, { ...lane, deadlineIndex: 4 });
	assert.deepEqual(overdue[1]?.warnings, ["晚于回应期限"]);
	assert.ok(overdue.every((entry) => !entry.deadline));
});

test("情节摘录只取源文档首段的可读文本，不把标题或格式当摘要，不生成解释", () => {
	assert.equal(
		contractExcerpt("---\ntitle: 标题\n---\n# 标题\n\n第一段有**强调**与[人名](a.md)。\n\n第二段。"),
		"第一段有强调与人名。",
	);
	assert.equal(contractExcerpt("# 只有标题"), "");
	assert.equal(contractExcerpt("甲".repeat(200)).length, 97);
	assert.ok(contractExcerpt("甲".repeat(200)).endsWith("…"));
});
