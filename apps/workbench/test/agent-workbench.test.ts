import assert from "node:assert/strict";
import test from "node:test";
import { captureWorkbenchContext, locateDocumentText } from "../src/agent-workbench.js";
import { emptyComposer, stageSubmission } from "../src/composer-state.js";
import { matchingDocumentPath } from "../src/document-navigation.js";
import { createTab, pageState } from "../src/view-state.js";
import { workspaceLayout } from "../src/workspace-layout.js";

test("界面上下文只带当前选区与元数据，发送后切页不改变冻结消息", () => {
	const layout = workspaceLayout();
	const group = layout.groups[0];
	assert.ok(group);
	group.tabs = [
		createTab({ ...pageState("file:甲.md"), edit: "edit", targetPath: "甲.md", selectedText: "选中的一句" }),
	];
	layout.documents["甲.md"] = { content: "未被选中的全文不应发送", baseContent: "原文", baseSHA: "a" };
	const context = captureWorkbenchContext(layout);
	assert.equal(context.active.path, "甲.md");
	assert.equal(context.active.unsaved, true);
	assert.equal(context.active.selection, "选中的一句");
	const sent = stageSubmission({ ...emptyComposer(), goal: "修改这里" }, undefined, context.active);
	assert.ok(sent.pending);
	assert.match(sent.pending.text, /甲.md/);
	assert.match(sent.pending.text, /选中的一句/);
	assert.doesNotMatch(sent.pending.text, /未被选中的全文/);
	const tab = group.tabs[0];
	assert.ok(tab);
	tab.location = pageState("file:乙.md");
	assert.notEqual(captureWorkbenchContext(layout).location, context.location);
	assert.doesNotMatch(sent.pending.text, /乙.md/);
});

test("定位不猜测：重复引文、丢失引文和越界行明确拒绝，行号可消歧", () => {
	assert.deepEqual(locateDocumentText("甲\n乙\n甲", { line: 2 }), { from: 2, to: 3 });
	assert.throws(() => locateDocumentText("甲\n乙\n甲", { quote: "甲" }), /多处/);
	assert.deepEqual(locateDocumentText("甲\n乙\n甲", { line: 3, quote: "甲" }), { from: 4, to: 5 });
	assert.throws(() => locateDocumentText("甲", { quote: "乙" }), /找不到/);
	assert.throws(() => locateDocumentText("甲甲", { line: 1, quote: "甲" }), /多处/);
	assert.throws(() => locateDocumentText("甲", { line: 2 }), /行号/);
});

test("界面与文件同步共用大小写匹配，不混淆大小写敏感文件系统", () => {
	assert.equal(matchingDocumentPath("NOTES.md", ["notes.md"], true), "notes.md");
	assert.equal(matchingDocumentPath("NOTES.md", ["notes.md"], false), "NOTES.md");
});

test("非文件工作面保留页面身份，私有文件不自动披露选区", () => {
	const layout = workspaceLayout();
	const group = layout.groups[0];
	assert.ok(group);
	group.tabs = [createTab(pageState("version:revision-one"))];
	const version = captureWorkbenchContext(layout);
	assert.equal(version.active.page, "version:revision-one");
	assert.equal(version.active.path, undefined);
	group.tabs = [createTab({ ...pageState("file:.codex/config.toml"), selectedText: "私有选区" })];
	const privateFile = captureWorkbenchContext(layout);
	assert.equal(privateFile.active.page, "private");
	assert.equal(privateFile.active.selection, undefined);
	assert.deepEqual(privateFile.openDocuments, []);
});
