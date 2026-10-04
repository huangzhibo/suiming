import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "../src/index.js";

test("持有者变化按 Beat 顺序生效，最终状态是最后一次赋值", () => {
	const result = evaluate({
		profileVersion: "state-projection-p0@2",
		initial: [{ subject: "resource:钥匙", property: "holder", value: "character:甲", scope: "world" }],
		changes: [
			{
				storyBeatId: "beat-0001",
				assignments: [{ subject: "resource:钥匙", property: "holder", value: "character:乙", scope: "world" }],
			},
		],
		authorizedBeatIds: ["beat-0001"],
	});
	assert.equal(result.passed, true);
	assert.equal(result.finalState.find((item) => item.property === "holder")?.value, "character:乙");
});

test("不可逆死亡不能被后续 Beat 撤销", () => {
	const result = evaluate({
		profileVersion: "state-projection-p0@2",
		initial: [],
		authorizedBeatIds: ["beat-0001", "beat-0002"],
		changes: [
			{
				storyBeatId: "beat-0001",
				assignments: [{ subject: "character:甲", property: "dead", value: true, scope: "world" }],
			},
			{
				storyBeatId: "beat-0002",
				assignments: [{ subject: "character:甲", property: "dead", value: false, scope: "world" }],
			},
		],
	});
	assert.equal(result.passed, false);
	assert.equal(result.failures[0]?.code, "dead_state_reversed");
});
