import assert from "node:assert/strict";
import test from "node:test";
import { bindDesignDocuments, type DesignDocuments, storyDependentClosure } from "../src/index.js";

/** 六节一卷，refs.beat 按参数声明；只有依赖关系，没有别的内容。 */
function design(dependencies: Record<number, number[]>) {
	const beatId = (index: number) => `beat-${String(index).padStart(4, "0")}`;
	const ids = [1, 2, 3, 4, 5, 6].map(beatId);
	const documents: DesignDocuments = {
		storyIndex: { schema_version: 2, volumes: [{ id: "vol-0001", title: "第一卷", beat_ids: ids }] },
		beats: [1, 2, 3, 4, 5, 6].map((index) => {
			const refs = dependencies[index]?.map(beatId) ?? [];
			return {
				volumeId: "vol-0001",
				beatId: beatId(index),
				path: `outline/story/vol-0001/${beatId(index)}.md`,
				markdown: `---\ntitle: 第${index}场\n${refs.length > 0 ? `refs:\n  beat: [${refs.join(", ")}]\n` : ""}---\n第${index}场发生的事。\n`,
			};
		}),
		characters: [],
		places: [],
		resources: [],
		world: [],
		contracts: [],
		intents: [],
		styleIds: [],
	};
	return bindDesignDocuments(documents).story;
}

const closure = (story: ReturnType<typeof design>, root: string) =>
	storyDependentClosure(story, [root]).map((beat) => beat.id);

test("依赖闭包：跨节的 refs.beat 层层传递，声明了对上一节的依赖只算一跳、不往后传", () => {
	// 抽出来的作品常常每节都连上一节（示例三国一半的 refs.beat 只跨一节）。原来闭包沿这条链一路传下去，
	// 改前半本任何一节，impact 召回后文的 87%，等于没召回。顺序本身已经表达相邻，接缝只影响下一节。
	const chain = design({ 2: [1], 3: [2], 4: [3], 5: [4], 6: [5] });
	assert.deepEqual(closure(chain, "beat-0001"), ["beat-0002"]);
	// 跨节的依赖照旧传递；从跨节依赖到达的那一节，它的下一节同样只算一跳。
	const mixed = design({ 3: [2], 4: [3], 5: [2], 6: [5] });
	assert.deepEqual(closure(mixed, "beat-0002"), ["beat-0003", "beat-0005", "beat-0006"]);
	const long = design({ 3: [1], 5: [3] });
	assert.deepEqual(closure(long, "beat-0001"), ["beat-0003", "beat-0005"]);
});
