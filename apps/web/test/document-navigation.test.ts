import assert from "node:assert/strict";
import test from "node:test";
import { documentTarget, openDocument } from "../src/document-navigation.js";
import { Book, type FileEntry, filePage, type WorkspaceData } from "../src/model.js";
import { activeView, createTab, DEFAULT_VIEW, editDocument, pageState, patchView } from "../src/view-state.js";
import { groupView, resolveWorkspaceDocuments, splitGroup, workspaceLayout } from "../src/workspace-layout.js";

const design = "outline/story/vol-0001/beat-0001.md";
const prose = "text/beat-0001.md";
const source = "source/example/outline/story/vol-0001/beat-0001.md";
const file = (path: string, kind: string, namespace = "target"): FileEntry => ({
	path,
	kind,
	namespace,
	localId: "beat-0001",
	frontmatter: {},
	codePoints: 1,
	dirty: false,
});
const book = new Book({
	files: [
		file(design, "story-beat"),
		file(prose, "story-text"),
		file(source, "story-beat", "example"),
		file("outline/story/index.yaml", "story-index"),
	],
	volumes: [],
} as unknown as WorkspaceData);
const initial = () => ({ ...DEFAULT_VIEW, tabs: [createTab(pageState(design))] });

test("文件树与对象共用页面，设计 / 正文定位准确；普通文件、材料与差异不误归属", () => {
	let state = patchView(initial(), { beatView: "text" });
	state = openDocument(state, book, filePage(design));
	assert.equal(state.tabs.length, 1);
	assert.equal(activeView(state).page, design);
	assert.equal(activeView(state).beatView, "design");
	state = openDocument(state, book, filePage(prose));
	assert.equal(state.tabs.length, 1);
	assert.equal(activeView(state).beatView, "text");
	assert.equal(activeView(state).resolveContent, false);
	assert.equal(documentTarget(book, prose).page, design);
	assert.equal(documentTarget(book, filePage("AGENTS.md")).page, filePage("AGENTS.md"));
	assert.equal(documentTarget(book, filePage("text/broken.txt")).page, filePage("text/broken.txt"));
	assert.equal(documentTarget(book, `diff:${prose}`).page, `diff:${prose}`);
	assert.equal(documentTarget(book, filePage(source)).page, source);
	assert.equal(documentTarget(book, filePage(source)).isBeat, false);
	assert.equal(documentTarget(book, "outline/story/index.yaml").page, filePage("outline/story/index.yaml"));
	assert.equal(documentTarget(book, filePage("outline/story/index.yaml")).page, filePage("outline/story/index.yaml"));
});

test("已有编辑页切内容同时切保存目标，两份草稿与光标独立；普通激活不重置现场", () => {
	let state = patchView(initial(), {
		edit: "edit",
		targetPath: design,
		editors: { [`${design}:edit`]: { anchor: 3, head: 3, top: 100 } },
	});
	state = editDocument(state, design, "设计草稿", { content: "设计", sha256: "1" });
	state = openDocument(state, book, filePage(prose), {}, {}, true);
	assert.equal(state.tabs.length, 1);
	assert.equal(activeView(state).targetPath, prose);
	assert.equal(activeView(state).edit, "edit");
	state = editDocument(state, prose, "正文草稿", { content: "正文", sha256: "2" });
	state = openDocument(state, book, design);
	assert.equal(activeView(state).targetPath, prose, "普通对象导航只激活现有现场");
	state = openDocument(state, book, filePage(design));
	assert.equal(activeView(state).targetPath, design);
	assert.equal(state.documents[design]?.content, "设计草稿");
	assert.equal(state.documents[prose]?.content, "正文草稿");
	assert.equal(activeView(state).editors[`${design}:edit`]?.top, 100);
	state = openDocument(state, book, filePage(prose), {}, { newTab: true, background: true });
	assert.equal(state.tabs.length, 2);
	assert.equal(activeView(state).targetPath, design);
	assert.equal(state.tabs[1]?.location.beatView, "text");
});

test("旧入口恢复统一身份，保留分屏、标签 ID、历史、未保存草稿与编辑位置", () => {
	let state = patchView(initial(), { page: filePage(prose), edit: "edit", targetPath: prose });
	state = editDocument(state, prose, "未保存", { content: "原文", sha256: "a" });
	const tab = state.tabs[0];
	assert.ok(tab);
	tab.back = [pageState(filePage(design)), pageState(filePage("notes.md"))];
	tab.forward = [pageState(prose)];
	tab.location.editors = { [`${prose}:edit`]: { anchor: 2, head: 2, top: 90 } };
	state.recentPages = [filePage(prose), design, filePage("notes.md")];
	const layout = workspaceLayout(state);
	const split = splitGroup(layout, layout.activeGroup, "horizontal");
	const restored = resolveWorkspaceDocuments(split, book);
	assert.equal(restored.groups.length, 2);
	assert.deepEqual(
		restored.groups.map((g) => g.tabs[0]?.id),
		split.groups.map((g) => g.tabs[0]?.id),
	);
	const location = activeView(groupView(restored));
	assert.equal(location.page, design);
	assert.equal(location.beatView, "text");
	assert.equal(location.targetPath, prose);
	assert.equal(location.edit, "edit");
	assert.equal(location.editors[`${prose}:edit`]?.top, 90);
	assert.equal(restored.groups[0]?.tabs[0]?.back[0]?.beatView, "design");
	assert.equal(restored.groups[0]?.tabs[0]?.back[1]?.page, filePage("notes.md"));
	assert.equal(restored.groups[0]?.tabs[0]?.forward[0]?.beatView, "text");
	assert.equal(restored.documents, split.documents);
	assert.deepEqual(restored.recentPages, [design, filePage("notes.md")]);
	assert.equal(resolveWorkspaceDocuments(restored, book), restored, "稳定的工作现场不重复改写");
});

test("显示名依次取 frontmatter 的 title、name、正文一级标题，都没有才用 id", () => {
	// 2026-10-01 斗破运行：Contract 没有 title / name，中文名只写在正文的 # 标题里，邻域图显示成 contract-yunlan-yingyue。
	const entry = (localId: string, extra: Partial<FileEntry>): FileEntry => ({
		path: `outline/contracts/${localId}.md`,
		kind: "story-contract",
		namespace: "target",
		localId,
		frontmatter: {},
		codePoints: 1,
		dirty: false,
		...extra,
	});
	const named = new Book({ files: [], volumes: [] } as unknown as WorkspaceData);
	assert.equal(named.title(entry("c1", { title: "标题", heading: "正文标题" })), "标题");
	assert.equal(named.title(entry("c2", { frontmatter: { name: "白墨" }, heading: "白墨（同窗）" })), "白墨");
	assert.equal(named.title(entry("contract-yunlan-yingyue", { heading: "云岚宗的备战与声誉" })), "云岚宗的备战与声誉");
	assert.equal(named.title(entry("c4", {})), "c4");
});
