import assert from "node:assert/strict";
import test from "node:test";
import { candidateFromStoryFiles } from "../src/artifact/change-operations.js";
import {
	DESIGN_FRAME_FULL_RENDER_CODE_POINTS,
	designArtifactIdentities,
	designFrame,
	frameSelections,
} from "../src/artifact/design-frame.js";
import { storyPackageCodec } from "../src/artifact/story-package-codec.js";
import { sampleWorkFiles } from "./sample-work.js";
import { syntheticWorkFiles } from "./synthetic-work.js";

function pathsOf(frame: ReturnType<typeof designFrame>, candidate: ReturnType<typeof candidateFromStoryFiles>) {
	return frame.artifacts.map((identity) => storyPackageCodec.pathForIdentity(identity, candidate));
}

test("Design 低于阈值时 Frame 退化为全量渲染", () => {
	const candidate = candidateFromStoryFiles("rev-1", sampleWorkFiles());
	const frame = designFrame(candidate, { seeds: [{ kind: "beat", id: "beat-0002" }] });
	assert.equal(frame.mode, "full");
	assert.ok(frame.totalCodePoints < DESIGN_FRAME_FULL_RENDER_CODE_POINTS);
	assert.deepEqual(frame.artifacts, designArtifactIdentities(candidate));
	assert.ok(frame.text.includes('--- BEGIN ARTIFACT "outline/story/vol-0001/beat-0001.md" ---'));
	assert.equal(frame.text.includes("未载入的 Design 目录"), false);
});

test("超过阈值的 Design 按 seeds 的 impact 闭包裁剪：目标卷整卷载入，其余卷只进目录，Intent / index / Contract / core 始终载入", () => {
	const candidate = candidateFromStoryFiles("rev-1", syntheticWorkFiles());
	const total = designArtifactIdentities(candidate).length;
	const frame = designFrame(candidate, { seeds: [{ kind: "beat", id: "beat-0015" }] });
	assert.equal(frame.mode, "framed");
	assert.ok(
		frame.totalCodePoints > DESIGN_FRAME_FULL_RENDER_CODE_POINTS,
		`合成 Design 只有 ${frame.totalCodePoints} 码点`,
	);
	assert.equal(frame.totalArtifacts, total);
	assert.ok(frame.artifacts.length < total, "载入的 artifact 必须少于全书");

	const loaded = new Set(pathsOf(frame, candidate));
	// 目标 Beat 所在的第二卷整卷载入，第一、三卷不载入
	for (let index = 13; index <= 24; index += 1) {
		assert.ok(loaded.has(`outline/story/vol-0002/beat-${String(index).padStart(4, "0")}.md`), `beat-${index} 应载入`);
	}
	assert.equal(loaded.has("outline/story/vol-0001/beat-0001.md"), false);
	assert.equal(loaded.has("outline/story/vol-0003/beat-0030.md"), false);
	// 始终载入的骨架
	for (const path of ["intent/主旨.md", "outline/story/index.yaml", "world/core.md", "outline/contracts/承诺1.md"]) {
		assert.ok(loaded.has(path), `${path} 应始终载入`);
	}
	// 目标 Beat 引用的人物与地点载入
	assert.ok(
		loaded.has("world/places/城西.md") || loaded.has("world/places/北道.md") || loaded.has("world/places/渡口.md"),
	);
	assert.ok([...loaded].some((path) => path.startsWith("world/characters/")));
	// 未载入的进目录，带标题与 refs，模型可以 read
	assert.ok(frame.text.includes("## 未载入的 Design 目录"));
	assert.ok(frame.text.includes("- outline/story/vol-0003/beat-0030.md — 第30场 · refs:"));
	assert.equal(frame.text.includes('--- BEGIN ARTIFACT "outline/story/vol-0003/beat-0030.md" ---'), false);
	assert.ok(frame.text.startsWith("（选择性 Context：全书 Design 共"));
});

test("Frame 选择过滤掉已被删除的 artifact", () => {
	const candidate = candidateFromStoryFiles("rev-1", syntheticWorkFiles());
	const frame = designFrame(candidate, {
		seeds: [
			{ kind: "beat", id: "beat-0003" },
			{ kind: "character", id: "人物03" },
		],
	});
	assert.equal(frame.mode, "framed");
	const without = {
		...candidate,
		artifacts: candidate.artifacts.filter((artifact) => artifact.path !== "outline/story/vol-0001/beat-0003.md"),
	};
	const selected = frameSelections(frame, without);
	assert.equal(selected.length, frame.artifacts.length - 1);
	assert.equal(
		selected.some((item) => item.identity.localId === "beat-0003"),
		false,
	);
});

test("没有 seeds 时只载入骨架，全部 Beat 与人物进目录", () => {
	const candidate = candidateFromStoryFiles("rev-1", syntheticWorkFiles());
	const frame = designFrame(candidate, { seeds: [] });
	assert.equal(frame.mode, "framed");
	const loaded = pathsOf(frame, candidate);
	assert.equal(
		loaded.some((path) => path.startsWith("outline/story/vol-")),
		false,
	);
	assert.ok(loaded.includes("outline/story/index.yaml"));
	assert.ok(frame.text.includes("- outline/story/vol-0001/beat-0001.md — 第1场"));
});

test("excludeStoryBeatIds：被排除的 Beat 永不载入、目录里标明晚于时点；目标卷其余 Beat 照常载入", () => {
	const candidate = candidateFromStoryFiles("rev-1", syntheticWorkFiles());
	const excluded = new Set(["beat-0020", "beat-0021", "beat-0022", "beat-0023", "beat-0024"]);
	const frame = designFrame(candidate, { seeds: [{ kind: "beat", id: "beat-0015" }], excludeStoryBeatIds: excluded });
	const loaded = new Set(pathsOf(frame, candidate));
	assert.ok(loaded.has("outline/story/vol-0002/beat-0019.md"));
	assert.equal(loaded.has("outline/story/vol-0002/beat-0020.md"), false);
	assert.ok(frame.text.includes("- outline/story/vol-0002/beat-0020.md — 第20场 · refs:"));
	assert.ok(frame.text.includes("晚于时点，不作为证据"));
});
