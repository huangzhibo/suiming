import assert from "node:assert/strict";
import test from "node:test";
import { axisModel, contractStatus, visibleRange } from "../src/axis/layout.js";
import { Book, type WorkspaceData } from "../src/model.js";

const file = (
	kind: string,
	path: string,
	localId: string,
	frontmatter: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) => ({
	path,
	kind,
	localId,
	namespace: "target",
	title: localId,
	frontmatter,
	dirty: false,
	codePoints: 100,
	mediaType: "text/markdown",
	...extra,
});
/** 两卷五个 Beat，index 顺序故意让 beat-0005 排在第一卷中间：id 不代表顺序。 */
const data = {
	projectId: "p",
	checkoutPath: "/tmp/长夜来信",
	revisionId: "r1",
	dirty: false,
	volumes: [
		{ id: "vol-0001", title: "赤壁之战", beatIds: ["beat-0001", "beat-0005", "beat-0002"] },
		{ id: "vol-0002", title: "转折", beatIds: ["beat-0003", "beat-0004"] },
	],
	storyText: [
		{ storyBeatId: "beat-0001", state: "current", writtenAt: "r1", changed: [] },
		{ storyBeatId: "beat-0002", state: "design-changed", writtenAt: "r1", changed: ["world/core.md"] },
	],
	files: [
		file("story-beat", "outline/story/vol-0001/beat-0001.md", "beat-0001", { contracts: { open: ["诈降"] } }),
		file("story-beat", "outline/story/vol-0001/beat-0005.md", "beat-0005", {
			contracts: { advance: ["诈降"] },
		}),
		file("story-beat", "outline/story/vol-0001/beat-0002.md", "beat-0002", {
			contracts: { resolve: ["诈降"] },
		}),
		file("story-beat", "outline/story/vol-0002/beat-0003.md", "beat-0003", {
			contracts: { advance: ["诈降"] },
		}),
		file("story-beat", "outline/story/vol-0002/beat-0004.md", "beat-0004", { contracts: { open: ["未兑现"] } }),
		file("story-text", "text/beat-0001.md", "beat-0001", {}),
		file("story-text", "text/beat-0002.md", "beat-0002", {}),
		file("story-contract", "outline/contracts/诈降.md", "诈降", {
			deadline: "beat-0002",
			subjects: { character: ["黄盖"] },
		}),
		file("story-contract", "outline/contracts/未兑现.md", "未兑现", { deadline: "book_end" }),
		file("story-contract", "outline/contracts/孤立.md", "孤立", {}),
	],
	revisions: [],
	runs: [],
} as unknown as WorkspaceData;

test("故事轴按 index 顺序编号，卷分段随之；正文状态来自 lineage", () => {
	const model = axisModel(new Book(data), []);
	assert.deepEqual(
		model.beats.map((beat) => beat.id),
		["beat-0001", "beat-0005", "beat-0002", "beat-0003", "beat-0004"],
	);
	assert.deepEqual(
		model.volumes.map((volume) => [volume.title, volume.start, volume.end]),
		[
			["赤壁之战", 0, 2],
			["转折", 3, 4],
		],
	);
	assert.deepEqual(
		model.beats.map((beat) => beat.text),
		["committed", "none", "incompatible", "none", "none"],
	);
});

test("承诺生命周期按 ordinal 计算：deadline、resolve 之后的 advance、没有锚点的承诺不画", () => {
	const model = axisModel(new Book(data), []);
	assert.deepEqual(
		model.contracts.map((lane) => lane.id),
		["诈降", "未兑现"],
	);
	const first = model.contracts[0];
	assert.deepEqual([first?.open, first?.advance, first?.resolve], [[0], [1, 3], [2]]);
	assert.deepEqual(first?.late, [3]);
	assert.equal(first?.deadlineIndex, 2);
	assert.deepEqual(first?.subjects, ["黄盖"]);
	assert.equal(model.contracts[1]?.deadlineIndex, 4);
	assert.equal(contractStatus(first as NonNullable<typeof first>, 0), "等待回应");
	assert.equal(contractStatus(first as NonNullable<typeof first>, 4), "已回应 · 第 3 个情节");
	assert.equal(
		contractStatus(first as NonNullable<typeof first>, 4, (ordinal) => model.beats[ordinal]?.id ?? ""),
		"已回应 · beat-0002",
	);
	assert.equal(contractStatus(model.contracts[1] as NonNullable<typeof first>, 2), "尚未建立");
});

test("全书未完待续（index 的 open_ended）：book_end 的承诺在最后一个 Beat 也只是等待回应，不画期限", () => {
	const finished = axisModel(new Book(data), []).contracts[1];
	assert.equal(contractStatus(finished as NonNullable<typeof finished>, 4), "已到期限，尚未回应");
	const ongoing = axisModel(new Book({ ...data, openEnded: true } as WorkspaceData), []).contracts[1];
	assert.equal(ongoing?.deadlineIndex, -1);
	assert.equal(contractStatus(ongoing as NonNullable<typeof ongoing>, 4), "等待回应");
	// 写明 Beat 期限的承诺不受影响
	assert.equal(axisModel(new Book({ ...data, openEnded: true } as WorkspaceData), []).contracts[0]?.deadlineIndex, 2);
	// 左侧身份列表用的 Book.contractState 与故事轴同一条规则
	assert.equal(new Book(data).contractState("未兑现", 4).label, "已到期限，尚未回应");
	assert.equal(new Book({ ...data, openEnded: true } as WorkspaceData).contractState("未兑现", 4).label, "等待回应");
});

test("可见范围：进入某一卷只画那一卷，null 或找不到的卷画全书", () => {
	const model = axisModel(new Book(data), []);
	assert.deepEqual(visibleRange(model, "vol-0002"), { start: 3, end: 4 });
	assert.deepEqual(visibleRange(model, "vol-missing"), { start: 0, end: 4 });
	assert.deepEqual(visibleRange(model, null), { start: 0, end: 4 });
});

test("审稿：只锚一个 Beat 的报告按列归组，覆盖多个 Beat 的报告成为区间", () => {
	const reviews = [
		{
			id: "rr1",
			layer: "text",
			verdict: "revise",
			summary: "",
			current: true,
			revision: "r1",
			changed: [],
			path: "review/x.md",
			paths: ["text/beat-0001.md"],
			findings: [],
		},
		{
			id: "rr2",
			layer: "design",
			verdict: "pass",
			summary: "",
			current: false,
			revision: "r1",
			changed: [],
			path: "review/x.md",
			paths: [
				"outline/story/vol-0001/beat-0001.md",
				"outline/story/vol-0002/beat-0004.md",
				"outline/story/vol-0001/beat-0002.md",
			],
			findings: [],
		},
		{
			id: "rr3",
			layer: "design",
			verdict: "pass",
			summary: "",
			current: true,
			revision: "r1",
			changed: [],
			path: "review/x.md",
			paths: ["intent/book.md"],
			findings: [],
		},
	];
	const model = axisModel(new Book(data), reviews as never);
	assert.deepEqual([...model.reviews.keys()], [0]);
	assert.equal(model.reviews.get(0)?.[0]?.reportId, "rr1");
	assert.deepEqual(
		model.spans.map((span) => [span.reportId, span.start, span.end, span.current]),
		[["rr2", 0, 4, false]],
	);
});

test("因果弧、人物泳道与世界文档都只读 frontmatter：refs.beat、refs.character、changes", () => {
	const rich = {
		...data,
		files: [
			...data.files.map((entry) =>
				entry.localId === "beat-0003"
					? {
							...entry,
							frontmatter: {
								...entry.frontmatter,
								refs: { beat: ["beat-0001"], character: ["黄盖"], world: ["旧案"] },
								changes: {
									world: { "黄盖.dead": true, "火船.location": "赤壁" },
									character: { 荀彧: { "secret:火船.revealed": true } },
								},
							},
						}
					: entry.localId === "beat-0001"
						? {
								...entry,
								frontmatter: {
									...entry.frontmatter,
									refs: { character: ["黄盖", "荀彧"] },
									changes: { world: { "黄盖.location": "赤壁" } },
								},
							}
						: entry.localId === "beat-0004"
							? {
									...entry,
									frontmatter: {
										...entry.frontmatter,
										refs: { beat: ["beat-0003", "beat-0001"], character: ["黄盖"] },
									},
								}
							: entry,
			),
			file("character", "world/characters/黄盖.md", "黄盖", {}),
			file("character", "world/characters/荀彧.md", "荀彧", {}),
			file("character", "world/characters/路人.md", "路人", {}),
			file("world", "world/旧案.md", "旧案", {}),
		],
	} as unknown as WorkspaceData;
	const model = axisModel(new Book(rich), []);
	assert.deepEqual(
		model.arcs.map((arc) => [arc.from, arc.to]),
		[
			[0, 3],
			[0, 4],
			[3, 4],
		],
	);
	assert.deepEqual(
		model.characters.map((lane) => [lane.id, lane.present, lane.deadAt]),
		[
			["黄盖", [0, 3, 4], 3],
			["荀彧", [0], -1],
		],
	);
	assert.deepEqual(
		model.characters[0]?.events.map((event) => [event.ordinal, event.kind]),
		[
			[0, "location"],
			[3, "dead"],
		],
	);
	assert.deepEqual(
		model.characters[1]?.events.map((event) => event.note),
		["秘密揭示：火船"],
	);
	assert.deepEqual(
		model.worlds.map((lane) => [lane.title, lane.present]),
		[["旧案", [3]]],
	);
});

test("硬状态键带不带 kind 前缀等价：裸 id 的秘密揭示、带前缀的人物与资源键都进泳道", () => {
	const rich = {
		...data,
		files: [
			...data.files.map((entry) =>
				entry.localId === "beat-0002"
					? {
							...entry,
							frontmatter: {
								...entry.frontmatter,
								refs: { character: ["黄盖"] },
								changes: {
									world: { "character:黄盖.dead": true, "resource:火船.holder": "荀彧" },
									character: { 荀彧: { "火船来历.revealed": true } },
								},
							},
						}
					: entry,
			),
			file("character", "world/characters/黄盖.md", "黄盖", {}),
			file("character", "world/characters/荀彧.md", "荀彧", {}),
			file("resource", "world/resources/火船.md", "火船", {}),
		],
	} as unknown as WorkspaceData;
	const model = axisModel(new Book(rich), []);
	assert.deepEqual(
		model.characters.map((lane) => [lane.id, lane.deadAt, lane.events.map((event) => event.note)]),
		[
			["黄盖", 2, ["死亡记录（changes.world.character:黄盖.dead）"]],
			["荀彧", -1, ["秘密揭示：火船来历"]],
		],
	);
	assert.deepEqual(
		model.resources.map((lane) => [lane.title, lane.events.map((event) => [event.ordinal, event.kind, event.value])]),
		[["火船", [[2, "holder", "荀彧"]]]],
	);
});

test("泳道只取 Target：Source 抽取里同名的人物、资源、世界与 Contract 不另起一条", () => {
	const source = (kind: string, dir: string, id: string, frontmatter: Record<string, unknown> = {}) =>
		file(kind, `source/原作/${dir}/${id}.md`, id, frontmatter, { namespace: "source" });
	const rich = {
		...data,
		files: [
			...data.files.map((entry) =>
				entry.localId === "beat-0002" && entry.kind === "story-beat"
					? {
							...entry,
							frontmatter: {
								...entry.frontmatter,
								refs: { character: ["黄盖"], world: ["旧案"] },
								changes: { world: { "黄盖.dead": true, "火船.holder": "荀彧" } },
							},
						}
					: entry,
			),
			file("character", "world/characters/黄盖.md", "黄盖", {}),
			file("resource", "world/resources/火船.md", "火船", { initial: { holder: "黄盖" } }),
			file("world", "world/旧案.md", "旧案", {}),
			source("character", "world/characters", "黄盖"),
			source("resource", "world/resources", "火船", { initial: { holder: "黄盖" } }),
			source("world", "world", "旧案"),
			source("story-contract", "outline/contracts", "诈降", { deadline: "beat-0002" }),
			source("story-beat", "outline/story/vol-0001", "beat-0001"),
			source("story-beat", "outline/story/vol-0001", "beat-0002"),
		],
	} as unknown as WorkspaceData;
	// Source 审稿锚的是 source/ 下同名 Beat：不能按 localId 落到 Target 的列上，画成一条覆盖全书的区间
	const sourceReview = {
		id: "src",
		layer: "source",
		verdict: "revise",
		summary: "",
		current: true,
		revision: "r1",
		changed: [],
		path: "review/src.md",
		paths: ["source/原作/outline/story/vol-0001/beat-0001.md", "source/原作/outline/story/vol-0001/beat-0002.md"],
		findings: [{ paths: ["source/原作/outline/story/vol-0001/beat-0001.md"] }],
	};
	const model = axisModel(new Book(rich), [sourceReview] as never);
	assert.deepEqual([...model.reviews.keys()], []);
	assert.deepEqual(model.spans, []);
	assert.deepEqual([...model.findings.keys()], []);
	assert.deepEqual(
		model.characters.map((lane) => lane.path),
		["world/characters/黄盖.md"],
	);
	assert.deepEqual(
		model.resources.map((lane) => lane.path),
		["world/resources/火船.md"],
	);
	assert.deepEqual(
		model.worlds.map((lane) => lane.path),
		["world/旧案.md"],
	);
	assert.deepEqual(
		model.contracts.map((lane) => lane.path),
		["outline/contracts/诈降.md", "outline/contracts/未兑现.md"],
	);
});

test("邻域：左列是它依赖的、右列是依赖它的，按 kind 分组，Beat 按顺序", async () => {
	const { neighborhoodFor } = await import("../src/axis/neighborhood.js");
	const rich = {
		...data,
		files: [
			...data.files.map((entry) =>
				entry.localId === "beat-0004"
					? {
							...entry,
							frontmatter: {
								...entry.frontmatter,
								refs: { beat: ["beat-0003", "beat-0001"], character: ["黄盖"] },
							},
						}
					: entry,
			),
			file("character", "world/characters/黄盖.md", "黄盖", {}),
		],
	} as unknown as WorkspaceData;
	const book = new Book(rich);
	const around = neighborhoodFor(book, "outline/story/vol-0002/beat-0004.md");
	assert.deepEqual(
		around.up.map((group) => [group.label, group.items.map((item) => `${item.title}:${item.key}`)]),
		[
			["情节", ["beat-0001:refs.beat", "beat-0003:refs.beat"]],
			["读者期待", ["未兑现:contracts.open"]],
			["人物", ["黄盖:refs.character"]],
		],
	);
	assert.deepEqual(around.down, []);
	const contract = neighborhoodFor(book, "outline/contracts/诈降.md");
	assert.deepEqual(
		contract.down.map((group) => [group.label, group.items.map((item) => item.key)]),
		[["情节", ["contracts.open", "contracts.advance", "contracts.resolve", "contracts.advance"]]],
	);
	assert.deepEqual(
		contract.up.map((group) => group.items.map((item) => `${item.title}:${item.key}`)),
		[["beat-0002:deadline"], ["黄盖:subjects.character"]],
	);
});

test("资源流转与 finding 密度：initial.holder 起点、changes 的 holder / location / consumed，finding 按锚到的 Beat 计数", () => {
	const rich = {
		...data,
		files: [
			...data.files.map((entry) =>
				entry.localId === "beat-0003"
					? { ...entry, frontmatter: { ...entry.frontmatter, changes: { world: { "火船.holder": "荀彧" } } } }
					: entry.localId === "beat-0004"
						? { ...entry, frontmatter: { ...entry.frontmatter, changes: { world: { "火船.consumed": true } } } }
						: entry,
			),
			file("resource", "world/resources/火船.md", "火船", { initial: { holder: "黄盖" } }),
			file("resource", "world/resources/无人用.md", "无人用", {}),
		],
	} as unknown as WorkspaceData;
	const reviews = [
		{
			id: "rr1",
			layer: "text",
			verdict: "revise",
			summary: "",
			current: true,
			revision: "r1",
			changed: [],
			path: "review/x.md",
			paths: ["text/beat-0001.md"],
			findings: [
				{ title: "a", evidence: "", suggestion: "", paths: ["text/beat-0001.md"] },
				{ title: "b", evidence: "", suggestion: "", paths: ["text/beat-0001.md"] },
			],
		},
		{
			id: "rr2",
			layer: "text",
			verdict: "revise",
			summary: "",
			current: false,
			revision: "r1",
			changed: [],
			path: "review/x.md",
			paths: ["text/beat-0002.md"],
			findings: [{ title: "c", evidence: "", suggestion: "", paths: ["text/beat-0002.md"] }],
		},
	];
	const model = axisModel(new Book(rich), reviews as never);
	assert.deepEqual(
		model.resources.map((lane) => [
			lane.title,
			lane.initialHolder,
			lane.events.map((event) => [event.ordinal, event.kind, event.value]),
		]),
		[
			[
				"火船",
				"黄盖",
				[
					[3, "holder", "荀彧"],
					[4, "consumed", ""],
				],
			],
		],
	);
	// stale 报告的 finding 不计入密度。
	assert.deepEqual([...model.findings.entries()], [[0, 2]]);
});
