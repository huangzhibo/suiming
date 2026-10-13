import assert from "node:assert/strict";
import test from "node:test";
import { resourceEventGroups } from "../src/axis/object-details.js";

test("资源同节变化合并但不丢字段，按实际情节顺序排列", () => {
	const events = [
		{ ordinal: 5, kind: "holder" as const, value: "character:甲" },
		{ ordinal: 1, kind: "location" as const, value: "place:城" },
		{ ordinal: 5, kind: "consumed" as const, value: "true" },
	];
	const groups = resourceEventGroups(events);
	assert.deepEqual(
		groups.map((group) => [group.ordinal, group.events.length]),
		[
			[1, 1],
			[5, 2],
		],
	);
	assert.deepEqual(groups[1]?.events, [events[0], events[2]]);
	assert.deepEqual(resourceEventGroups([]), []);
});
