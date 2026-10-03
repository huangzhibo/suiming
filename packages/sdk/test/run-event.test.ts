import assert from "node:assert/strict";
import test from "node:test";
import { EventType, validateProductEvent } from "../src/index.js";

const none = { count: 0, paths: [] };
const turn = (content: unknown) => ({
	type: EventType.ACTIVITY_SNAPSHOT,
	messageId: "turn-1:summary",
	activityType: "suiming.turn",
	replace: true,
	content,
});

test("suiming.turn：turn 结束对账按 schema 校验，多一个字段或少一类都拒绝", () => {
	const valid = {
		authorMessages: 2,
		changed: {
			intent: { count: 1, paths: ["intent/揭开真相.md"] },
			design: none,
			text: none,
			review: none,
			other: none,
		},
		revisions: 1,
		uncommitted: 0,
	};
	assert.doesNotThrow(() => validateProductEvent(turn(valid) as Parameters<typeof validateProductEvent>[0]));
	assert.throws(
		() => validateProductEvent(turn({ ...valid, verdict: "done" }) as Parameters<typeof validateProductEvent>[0]),
		/suiming\.turn/u,
	);
	const { review: _review, ...missing } = valid.changed;
	assert.throws(
		() => validateProductEvent(turn({ ...valid, changed: missing }) as Parameters<typeof validateProductEvent>[0]),
		/suiming\.turn/u,
	);
	assert.throws(
		() =>
			validateProductEvent({
				...turn(valid),
				activityType: "suiming.unknown",
			} as Parameters<typeof validateProductEvent>[0]),
		/suiming\.unknown/u,
	);
});
