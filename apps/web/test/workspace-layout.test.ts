import assert from "node:assert/strict";
import test from "node:test";
import {
	activeView,
	createTab,
	DEFAULT_VIEW,
	editDocument,
	historyMove,
	navigate,
	openingPage,
	pageState,
	patchView,
	resolveComparisonLayout,
	resolveOpening,
	savedDocument,
} from "../src/view-state.js";
import {
	closeWorkspaceTab,
	groupView,
	mergeGroup,
	normalizePage,
	openComparison,
	resizePanes,
	restoreWorkspace,
	splitGroup,
	updateGroup,
	workspaceLayout,
	workspaceScreen,
} from "../src/workspace-layout.js";

const initial = () => ({ ...DEFAULT_VIEW, tabs: [createTab(pageState("beat/a"))] });
test("比较标签按文件与基线跨窗格去重，保留来源现场，普通导航不覆盖比较", () => {
	let layout = workspaceLayout(initial());
	const source = layout.activeGroup;
	const original = groupView(layout).tabs[0];
	layout = openComparison(layout, source, "text/a.md", "r1");
	const comparison = groupView(layout).tabs[1];
	assert.deepEqual(groupView(layout).tabs[0], original);
	assert.equal(comparison?.location.diffOrigin, original?.id);
	layout = openComparison(layout, source, "text/a.md", "r1");
	assert.equal(groupView(layout).tabs.length, 2);
	layout = splitGroup(layout, source, "horizontal", pageState("beat/b"));
	const other = layout.activeGroup;
	layout = openComparison(layout, other, "text/a.md", "r1");
	assert.equal(layout.activeGroup, source);
	layout = updateGroup(layout, source, (state) => navigate(state, pageState("beat/c")));
	assert.equal(groupView(layout).tabs.length, 3);
	assert.equal(groupView(layout).tabs[1]?.location.diffRevision, "r1");
	layout = openComparison(layout, other, "text/a.md", "r2");
	assert.equal(groupView(layout).tabs.length, 2, "不同基线是独立比较");
	layout = openComparison(layout, other, "text/a.md", "r1");
	layout = closeWorkspaceTab(layout, source, comparison?.id ?? "");
	assert.equal(groupView(layout).tabs[groupView(layout).active]?.id, original?.id);
});
test("设计优先；正文为空只回退这次访问，显式选择和历史不重新猜测", () => {
	let state = initial();
	assert.equal(activeView(state).beatView, "design");
	state = patchView(state, { beatView: "text" });
	state = navigate(state, openingPage("beat/b", state.beatPreference, true));
	assert.equal(activeView(state).resolveContent, true);
	const id = state.tabs[state.active]?.id ?? "";
	state = resolveOpening(state, id, false);
	assert.equal(activeView(state).beatView, "design");
	assert.equal(activeView(state).resolveContent, false);
	assert.equal(state.beatPreference, "text");
	const fallback = activeView(state).page;
	// 后台生成完成不跳页。
	assert.deepEqual(resolveOpening(state, id, true), state);
	state = navigate(state, openingPage("beat/c", state.beatPreference, true));
	state = resolveOpening(state, id, true);
	assert.equal(activeView(state).beatView, "text");
	state = historyMove(state, "back", false);
	assert.equal(activeView(state).page, fallback);
	assert.equal(activeView(state).beatView, "design");
	assert.equal(activeView(state).resolveContent, false);
	const explicit = openingPage("beat/empty", "design", true, { beatView: "text" });
	assert.equal(explicit.beatView, "text");
	assert.equal(explicit.resolveContent, false);
});
test("多窗格导航与位置独立，草稿和保存基线共享；分屏合并保留所有标签", () => {
	let layout = workspaceLayout(initial());
	const left = layout.activeGroup;
	layout = updateGroup(layout, left, (state) => patchView(state, { scrolls: { body: { top: 400, left: 0 } } }));
	layout = splitGroup(layout, left, "horizontal", { ...pageState("beat/a"), beatView: "text" });
	const right = layout.activeGroup;
	assert.equal(layout.groups.length, 2);
	layout = updateGroup(layout, right, (state) =>
		editDocument(state, "text/a.md", "draft", { content: "base", sha256: "1" }),
	);
	assert.equal(groupView(layout, left).documents["text/a.md"]?.content, "draft");
	layout = updateGroup(layout, right, (state) => navigate(state, pageState("beat/b")));
	assert.equal(activeView(groupView(layout, left)).page, "beat/a");
	assert.equal(activeView(groupView(layout, left)).scrolls.body?.top, 400);
	assert.deepEqual(activeView(groupView(layout, right)).scrolls, {});
	layout = updateGroup(layout, left, (state) => savedDocument(state, "text/a.md", "earlier", "2"));
	assert.deepEqual(groupView(layout, right).documents["text/a.md"], {
		content: "draft",
		baseContent: "earlier",
		baseSHA: "2",
	});
	layout = splitGroup(layout, right, "vertical");
	const lower = layout.activeGroup;
	assert.equal(layout.groups.length, 3);
	if (!("group" in layout.panes)) layout = { ...layout, panes: resizePanes(layout.panes, layout.panes.id, [35, 65]) };
	assert.ok(!("group" in layout.panes) && layout.panes.sizes[0] === 35);
	const before = layout.groups
		.flatMap((group) => group.tabs)
		.map((tab) => tab.id)
		.sort();
	layout = mergeGroup(layout, lower);
	assert.equal(layout.groups.length, 2);
	assert.deepEqual(
		layout.groups
			.flatMap((group) => group.tabs)
			.map((tab) => tab.id)
			.sort(),
		before,
	);
	assert.equal(activeView(groupView(layout, left)).scrolls.body?.top, 400);
	assert.equal(layout.documents["text/a.md"]?.content, "draft");
});

test("比较布局按实际宽度自动选择，手动选择与恢复不受窗口影响", () => {
	assert.equal(resolveComparisonLayout(null, 759), "unified");
	assert.equal(resolveComparisonLayout(null, 760), "split");
	assert.equal(resolveComparisonLayout("split", 600), "split");
	assert.equal(resolveComparisonLayout("unified", 1600), "unified");
	const saved = normalizePage({ ...pageState("diff:text/a.md"), diffLayout: "unified" });
	assert.equal(saved.diffLayout, "unified");
});

test("恢复时未确认提交与草稿完整保留，认不出的标签与多余字段丢掉，再存再读不变", () => {
	// 2026-10-04 删掉了 09-09 之前旧单窗格格式（字符串标签、graph: 前缀、context 字段）的迁移：
	// 那些格式只在开源前的本机存过，认不出的标签照样丢掉，不连带丢文件草稿与未确认提交。
	const pending = { id: "same-command", text: "冻结目标与引用", runId: "run-1" };
	const restored = restoreWorkspace({
		tabs: ["beat/b", { id: "tab-a", location: pageState("beat/a"), back: [pageState("beat/b")], forward: [] }],
		active: 99,
		documents: { "beat/a": { content: "未保存内容", baseContent: "原稿", baseSHA: "sha" } },
		composerDrafts: {
			new: {
				goal: "后续输入",
				attachments: [{ id: "s1", label: "作品引用", kind: "selection", status: "ready", content: "选段" }],
				pending,
			},
		},
	});
	assert.deepEqual(
		groupView(restored).tabs.map((tab) => tab.location.page),
		["beat/a"],
	);
	assert.equal(groupView(restored).active, 0);
	assert.equal(groupView(restored).tabs[0]?.back[0]?.page, "beat/b");
	assert.equal(restored.documents["beat/a"]?.content, "未保存内容");
	assert.deepEqual(restored.composerDrafts.new?.pending, { id: "same-command", text: "冻结目标与引用" });
	assert.equal(restored.composerDrafts.new?.attachments[0]?.content, "选段");
	const again = restoreWorkspace(JSON.parse(JSON.stringify(restored)));
	assert.deepEqual(again, restored);
});

test("多窗格恢复保留比例、编辑位置与阅读位置；无效树收回为单窗格但不丢标签草稿", () => {
	let original = workspaceLayout(initial());
	const first = original.activeGroup;
	original = updateGroup(original, first, (state) =>
		patchView(state, {
			scrolls: { "body:design": { top: 140, left: 0 } },
			editors: { "beat/a": { anchor: 3, head: 8, top: 80 } },
		}),
	);
	original = splitGroup(original, first, "horizontal", pageState("beat/b"));
	original = { ...original, composerDrafts: { new: { goal: "不能丢的输入", attachments: [] } } };
	assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(original))), original);
	for (const panes of [
		{ group: "missing" },
		{ id: "bad", orientation: "horizontal", first: { group: first }, second: { group: first } },
	]) {
		const restored = restoreWorkspace({ ...original, panes });
		assert.equal(restored.groups.length, 1);
		assert.deepEqual(
			groupView(restored).tabs.map((t) => t.location.page),
			["beat/a", "beat/b"],
		);
		assert.equal(groupView(restored).active, 1);
		assert.deepEqual(groupView(restored).tabs[0]?.location, groupView(original, first).tabs[0]?.location);
		assert.deepEqual(restored.composerDrafts, original.composerDrafts);
	}
});

test("恢复边界过滤无效标签并约束当前索引，不认识的页面字段丢掉", () => {
	const restored = restoreWorkspace({
		tabs: [
			null,
			{
				location: {
					page: "beat/a",
					fileView: "source",
					returnView: "preview",
					scrolls: { "body:design": { top: 70, left: 0 } },
				},
			},
		],
		active: -2,
	});
	const state = groupView(restored);
	assert.equal(state.tabs.length, 1);
	assert.equal(state.active, 0);
	assert.equal("fileView" in (state.tabs[0]?.location ?? {}), false);
	assert.deepEqual(state.tabs[0]?.location.scrolls, { "body:design": { top: 70, left: 0 } });
});

test("加载中不显示欢迎页：作品读不出来时等文件列表回来，两条都失败才是没有打开作品", () => {
	// 欢迎页上是「打开作品 / 开始新作」：重载或切换作品的那一瞬看到它，像是作品没了。
	assert.equal(workspaceScreen({ show: "pending", files: "pending" }), "loading");
	assert.equal(workspaceScreen({ show: "success", files: "pending" }), "workspace");
	assert.equal(workspaceScreen({ show: "error", files: "pending" }), "loading", "作品读不出来，先等文件列表");
	assert.equal(workspaceScreen({ show: "error", files: "success" }), "workspace", "退回文件浏览");
	assert.equal(workspaceScreen({ show: "error", files: "error" }), "welcome");
});
