import assert from "node:assert/strict";
import test from "node:test";
import { bindDesignDocuments, buildStateTimeline, checkDesign, type DesignDocuments } from "../src/index.js";

/**
 * 合成一部 500 Beat、40 人物、10 卷的长篇：每个 Beat 引用两三个人物，
 * 每 5 个 Beat 一次硬状态变化，每卷一个 Contract，用来守住 bind / check / Frame(t) 的规模上限。
 */
function syntheticLongForm(beatCount = 500, characterCount = 40): DesignDocuments {
	const volumeCount = 10;
	const perVolume = beatCount / volumeCount;
	const characters = Array.from({ length: characterCount }, (_, index) => `人物${String(index).padStart(2, "0")}`);
	const beatId = (index: number) => `beat-${String(index + 1).padStart(4, "0")}`;
	const volumes = Array.from({ length: volumeCount }, (_, volume) => ({
		id: `vol-${String(volume + 1).padStart(4, "0")}`,
		title: `第${volume + 1}卷`,
		beat_ids: Array.from({ length: perVolume }, (_, offset) => beatId(volume * perVolume + offset)),
	}));
	const beats: Array<DesignDocuments["beats"][number]> = [];
	for (let index = 0; index < beatCount; index += 1) {
		const volume = Math.floor(index / perVolume);
		const contractId = `承诺${volume + 1}`;
		const isFirstInVolume = index % perVolume === 0;
		const isLastInVolume = index % perVolume === perVolume - 1;
		const cast = [characters[index % characterCount], characters[(index * 7) % characterCount]];
		const refs = [`  character: [${[...new Set(cast)].join(", ")}]`, `  secret: [秘密${volume + 1}]`];
		if (index > 0 && index % 3 === 0) refs.push(`  beat: [${beatId(index - 1)}]`);
		const contracts = isFirstInVolume
			? `contracts:\n  open: [${contractId}]\n`
			: isLastInVolume
				? `contracts:\n  resolve: [${contractId}]\n`
				: "";
		const changes =
			index % 5 === 0
				? `changes:\n  world:\n    ${characters[index % characterCount]}.location: 城${index % 4}\n`
				: "";
		beats.push({
			volumeId: volumes[volume]?.id ?? "vol-0001",
			beatId: beatId(index),
			path: `outline/story/${volumes[volume]?.id}/${beatId(index)}.md`,
			markdown: `---\ntitle: 第${index + 1}场\nrefs:\n${refs.join("\n")}\n${contracts}${changes}---\n${cast[0]}在城${index % 4}遇到${cast[1]}，做出了一个改变后文的选择。\n`,
		});
	}
	return {
		storyIndex: { schema_version: 2, volumes },
		beats,
		characters: characters.map((id) => ({
			id,
			path: `world/characters/${id}.md`,
			markdown: `---\naliases: [${id}的别名]\n---\n${id}的轨迹基底。\n`,
		})),
		places: [0, 1, 2, 3].map((index) => ({
			id: `城${index}`,
			path: `world/places/城${index}.md`,
			markdown: `第${index}座城。\n`,
		})),
		resources: [],
		world: [],
		contracts: Array.from({ length: volumeCount }, (_, volume) => ({
			id: `承诺${volume + 1}`,
			path: `outline/contracts/承诺${volume + 1}.md`,
			markdown: `---\nsubjects:\n  character: [${characters[volume % characterCount]}]\ndeadline: ${beatId((volume + 1) * perVolume - 1)}\n---\n第${volume + 1}卷的长期期待。\n`,
		})),
		intents: [],
		styleIds: [],
	};
}

test("500 Beat 合成长篇的 bind、check 与 Frame(t) 快照在可接受时间内完成", () => {
	const documents = syntheticLongForm();
	const started = performance.now();
	const design = bindDesignDocuments(documents);
	const bound = performance.now();
	const check = checkDesign(design);
	const checked = performance.now();
	const timeline = buildStateTimeline(design.stateProjection);
	for (const beat of design.story.beats) timeline.stateBefore(beat.id);
	const projected = performance.now();

	assert.equal(design.story.beats.length, 500);
	assert.equal(check.passed, true, check.diagnostics.map((item) => item.message).join("\n"));
	assert.equal(check.contracts.results.length, 10);
	// 每个 Beat 都提到了未在 refs 中的人物别名以外的名字时会有 warning；这里只保证不会爆炸。
	assert.ok(check.warnings.length < 5000);

	const budgetMs = 5000;
	assert.ok(bound - started < budgetMs, `bind took ${(bound - started).toFixed(0)}ms`);
	assert.ok(checked - bound < budgetMs, `check took ${(checked - bound).toFixed(0)}ms`);
	assert.ok(projected - checked < budgetMs, `timeline took ${(projected - checked).toFixed(0)}ms`);
});
