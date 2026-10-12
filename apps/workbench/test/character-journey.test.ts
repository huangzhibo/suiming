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
	assert.equal(journey.overview, false, "少量经历不增加概览负担，即使分散到不同卷");
});

test("密集人物概览保留全部记录，空记录与单点都不画空分布图", () => {
	const dense = characterJourney(model, { ...lane, present: model.beats.map((beat) => beat.ordinal) });
	assert.equal(dense.overview, true);
	assert.equal(dense.entries.length, 20);
	assert.equal(dense.events.length, 3);
	const empty = characterJourney(model, { ...lane, present: [], events: [] });
	assert.equal(empty.overview, false);
	assert.equal(empty.groups.length, 0);
	const single = characterJourney({ ...model, beats: model.beats.slice(0, 1) }, { ...lane, present: [0], events: [] });
	assert.equal(single.entries[0]?.position, 50);
	assert.equal(single.overview, false);
});
