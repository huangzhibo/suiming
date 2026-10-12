import assert from "node:assert/strict";
import test from "node:test";
import { characterJourney } from "../src/axis/character-journey.js";
import type { AxisModel, CharacterLane } from "../src/axis/layout.js";

const model = {
	beats: Array.from({ length: 20 }, (_, ordinal) => ({
		id: `beat-${20 - ordinal}`,
		ordinal,
		volumeId: ordinal < 5 ? "v1" : "v2",
		title: `情节 ${ordinal}`,
		path: `beat-${20 - ordinal}.md`,
		text: "none",
		textPath: undefined,
		dirty: false,
	})),
	volumes: [
		{ id: "v1", title: "短卷", start: 0, end: 4 },
		{ id: "v2", title: "长卷", start: 5, end: 19 },
	],
} as AxisModel;
const lane: CharacterLane = {
	id: "人物",
	title: "人物",
	path: "人物.md",
	present: [4, 0, 4],
	events: [
		{ ordinal: 4, kind: "secret", note: "秘密揭示：身份" },
		{ ordinal: 4, kind: "location", note: "位置改为：江边" },
		{ ordinal: 19, kind: "dead", note: "死亡" },
	],
	deadAt: 19,
};

test("人物经历取顺序并集，保留同节多种变化和没有引用的状态；分布按全书顺序而非 id 或卷数", () => {
	const journey = characterJourney(model, lane);
	assert.deepEqual(
		journey.entries.map((entry) => entry.beat.ordinal),
		[0, 4, 19],
	);
	assert.deepEqual(
		journey.entries.map((entry) => entry.position),
		[2.5, 22.5, 97.5],
	);
	assert.equal(journey.entries[1]?.events.length, 2);
	assert.equal(journey.entries[1]?.kind, "secret");
	assert.equal(journey.entries[2]?.kind, "dead");
	assert.deepEqual(
		journey.groups.map((group) => group.entries.length),
		[2, 1],
	);
	assert.equal(journey.overview, true, "少量跨卷经历也保留全书位置");
});

test("全书分布覆盖所有有记录人物，空记录不画图，单点不拉伸坐标", () => {
	const dense = characterJourney(model, { ...lane, present: model.beats.map((beat) => beat.ordinal) });
	assert.equal(dense.overview, true);
	assert.equal(dense.entries.length, 20);
	assert.equal(dense.events.length, 3);
	const empty = characterJourney(model, { ...lane, present: [], events: [] });
	assert.equal(empty.overview, false);
	assert.equal(empty.groups.length, 0);
	const single = characterJourney({ ...model, beats: model.beats.slice(0, 1) }, { ...lane, present: [0], events: [] });
	assert.equal(single.entries[0]?.position, 50);
	assert.equal(single.overview, true);
	for (const count of [1, 4, 5, 8, 9]) {
		const sparse = characterJourney(model, {
			...lane,
			present: model.beats.slice(-count).map((beat) => beat.ordinal),
			events: [],
		});
		assert.equal(sparse.overview, true, `${count} 条记录均能查看全书位置`);
		assert.equal(sparse.entries.at(-1)?.position, 97.5, "末端单点保留全书坐标，不移到正中间");
	}
});
