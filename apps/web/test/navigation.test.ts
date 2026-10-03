import assert from "node:assert/strict";
import test from "node:test";
import {
	activeView,
	createTab,
	DEFAULT_VIEW,
	EMPTY_PAGE,
	editDocument,
	historyMove,
	navigate,
	pageState,
	patchView,
	removeTab,
	savedDocument,
} from "../src/view-state.js";

const initial = () => ({ ...DEFAULT_VIEW, tabs: [createTab(pageState("beat/a"))] });
test("普通导航复用并恢复视图历史；导航栏切换不动工作页面", () => {
	let state = patchView(initial(), { beatView: "design", scrolls: { body: { top: 360, left: 0 } } });
	const before = state.tabs[0]?.location;
	state = patchView(state, { side: "files", fileFolders: { text: true } });
	assert.deepEqual(state.tabs[0]?.location, before);
	state = navigate(state, pageState("beat/b"));
	assert.equal(state.tabs.length, 1);
	state = historyMove(state, "back", false);
	assert.deepEqual(state.tabs[0]?.location, before);
	state = historyMove(state, "forward", false);
	assert.equal(activeView(state).page, "beat/b");
});
test("固定和未保存保护、去重、显式后台副本、新建和末页关闭", () => {
	let state = initial();
	state.tabs = state.tabs.map((tab) => ({ ...tab, pinned: true }));
	state = navigate(state, pageState("beat/b"));
	assert.equal(state.tabs.length, 2);
	state = navigate(state, pageState("beat/a"));
	assert.equal(state.active, 0);
	state = navigate(state, pageState("beat/a"), { newTab: true, background: true });
	assert.equal(state.tabs.length, 3);
	assert.equal(state.active, 0);
	state = navigate(state, pageState(EMPTY_PAGE), { newTab: true });
	assert.equal(activeView(state).page, EMPTY_PAGE);
	for (const tab of [...state.tabs]) state = removeTab(state, tab.id);
	assert.equal(state.tabs.length, 1);
	assert.equal(activeView(state).page, EMPTY_PAGE);
	state = navigate(initial(), pageState("beat/b"));
	const previous = state.tabs[0];
	state = historyMove(state, "back", true);
	assert.equal(state.tabs.length, 2);
	assert.deepEqual(state.tabs[0], previous);
});
test("重复视图共享文件草稿，保存途中继续输入不会丢失；页面快照不共享光标", () => {
	let state = editDocument(initial(), "text/a.md", "first", { content: "base", sha256: "h1" });
	state = navigate(state, pageState("file:text/a.md"), { newTab: true });
	state = editDocument(state, "text/a.md", "second", { content: "stale", sha256: "h0" });
	assert.deepEqual(state.documents["text/a.md"], { content: "second", baseContent: "base", baseSHA: "h1" });
	state = savedDocument(state, "text/a.md", "first", "h2");
	assert.deepEqual(state.documents["text/a.md"], { content: "second", baseContent: "first", baseSHA: "h2" });
	state = patchView(state, { editors: { source: { anchor: 5, head: 8, top: 200 } } });
	assert.deepEqual(state.tabs[0]?.location.editors, {});
	state = savedDocument(state, "text/a.md", "second", "h3");
	assert.deepEqual(state.documents, {});
});
