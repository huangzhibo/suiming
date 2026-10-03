import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { evaluate, parseStateProjection, StateProjectionSchema } from "../src/index.js";

test("硬状态 wire schema 与执行器共享同一语义", () => {
	const wire = {
		profile_version: "state-projection-p0@2",
		initial: [{ subject: "resource:钥匙", property: "holder", value: "character:甲" }],
		changes: [
			{
				story_beat_id: "beat-0001",
				assignments: [{ subject: "resource:钥匙", property: "holder", value: "character:乙" }],
			},
		],
		authorized_beat_ids: ["beat-0001"],
	};
	assert.equal(Value.Check(StateProjectionSchema, wire), true);
	const result = evaluate(parseStateProjection(wire));
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
