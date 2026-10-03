import assert from "node:assert/strict";
import test from "node:test";
import { propertyRows } from "../src/artifact-properties.js";
import { Book, type FileEntry, type WorkspaceData } from "../src/model.js";

function file(kind: string, localId: string, frontmatter: Record<string, unknown> = {}, title = localId): FileEntry {
	return {
		kind,
		localId,
		path: `${kind}/${localId}.md`,
		title,
		namespace: "target",
		frontmatter,
		dirty: false,
		codePoints: 100,
	};
}
function properties(entry: FileEntry, others: FileEntry[] = []) {
	const book = new Book({ files: [entry, ...others], volumes: [] } as unknown as WorkspaceData);
	return propertyRows(book, entry);
}

test("属性用作品标题链接，秘密保持静态；隐藏重复标题但不丢弃不同的名称", () => {
	const rows = properties(
		file(
			"story-beat",
			"beat-0069",
			{
				title: "无功者",
				name: "另一名称",
				refs: { character: ["刘备"], secret: ["关羽亡命"], beat: ["beat-0001"] },
				contracts: { advance: ["太平"] },
			},
			"无功者",
		),
		[
			file("character", "刘备"),
			file("story-beat", "beat-0001", {}, "桃树下的三条路"),
			file("story-contract", "太平", {}, "三人同到太平"),
		],
	);
	assert.deepEqual(
		rows.map((row) => row.label),
		["名称", "相关人物", "相关秘密", "依赖情节", "推进期待"],
	);
	assert.deepEqual(rows[2]?.values, [{ text: "关羽亡命" }]);
	assert.deepEqual(rows[3]?.values, [{ text: "桃树下的三条路", path: "story-beat/beat-0001.md" }]);
	assert.deepEqual(rows[4]?.values, [{ text: "三人同到太平", path: "story-contract/太平.md" }]);
});

test("秘密披露严格区分世界、读者和指定人物，名字中的点不作为层级", () => {
	const rows = properties(
		file("story-beat", "beat-0001", {
			changes: {
				world: { "secret:单福.身份.revealed": true },
				reader: { "secret:单福.身份.revealed": false },
				character: { "刘.备": { "secret:单福.身份.revealed": true } },
			},
		}),
	);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.label, "本节变化");
	assert.deepEqual(
		rows[0]?.values.map((value) => value.text),
		["秘密「单福.身份」在故事世界中已公开", "读者尚未知晓秘密「单福.身份」", "刘.备已获知秘密「单福.身份」"],
	);
});

test("revealed 只属于 Secret：裸 id 与 secret: 前缀写法显示相同", () => {
	const rows = properties(
		file("story-beat", "beat-0001", {
			changes: { reader: { "单福身份.revealed": true }, character: { 刘备: { "单福身份.revealed": true } } },
		}),
	);
	assert.deepEqual(
		rows.map((row) => [row.label, row.values.map((value) => value.text)]),
		[["本节变化", ["读者已获知秘密「单福身份」", "刘备已获知秘密「单福身份」"]]],
	);
});

test("开场状态与本节变化分开，不补出缺省状态或把持有当成所有权", () => {
	const initial = properties(file("resource", "青釭剑", { initial: { holder: "夏侯恩", sealed: false } }));
	assert.equal(initial[0]?.label, "开场状态");
	assert.deepEqual(
		initial[0]?.values.map((value) => value.text),
		["青釭剑：由夏侯恩持有", "青釭剑：未封印"],
	);
	const changed = properties(
		file("story-beat", "beat-0001", {
			changes: { world: { "resource:青釭剑.holder": "character:赵云", "夏侯恩.dead": true } },
		}),
	);
	assert.equal(changed[0]?.label, "本节变化");
	assert.deepEqual(
		changed[0]?.values.map((value) => value.text),
		["青釭剑：由赵云持有", "夏侯恩：已死亡"],
	);
	assert.deepEqual(properties(file("character", "夏侯恩")), []);
});

test("无法解释的字段或状态类型保留原值，包括空值、false 和空集合", () => {
	const rows = properties(
		file("story-beat", "beat-0001", {
			custom: { empty: "", nil: null, enabled: false, count: 0, list: [], object: {} },
			changes: { world: { "secret:秘密.revealed": "maybe", "黄盖.unknown": true }, reader: { "黄盖.dead": true } },
		}),
	);
	assert.deepEqual(
		rows.map((row) => [row.label, row.values[0]?.text]),
		[
			["custom.empty", '""'],
			["custom.nil", "null"],
			["custom.enabled", "false"],
			["custom.count", "0"],
			["custom.list", "[]"],
			["custom.object", "{}"],
			["changes.world.secret:秘密.revealed", "maybe"],
			["changes.world.黄盖.unknown", "true"],
			["changes.reader.黄盖.dead", "true"],
		],
	);
});

test("回应期限显示情节标题或全书结束，未找到的引用保留实际 ID", () => {
	const entry = file("story-contract", "太平", { deadline: "beat-0002" });
	assert.deepEqual(properties(entry, [file("story-beat", "beat-0002", {}, "离开故乡")])[0]?.values, [
		{ text: "离开故乡", path: "story-beat/beat-0002.md" },
	]);
	assert.deepEqual(properties(entry)[0]?.values, [{ text: "beat-0002" }]);
	assert.deepEqual(properties(file("story-contract", "太平", { deadline: "book_end" }))[0]?.values, [
		{ text: "全书结束前" },
	]);
});
