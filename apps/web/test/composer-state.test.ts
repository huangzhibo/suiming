import assert from "node:assert/strict";
import test from "node:test";
import {
	acknowledgeSubmission,
	composerText,
	emptyComposer,
	settleComposerAttachment,
	stageSubmission,
	textFileAttachment,
	updateComposerDraft,
} from "../src/composer-state.js";
import { DEFAULT_VIEW } from "../src/view-state.js";
import { mergeGroup, splitGroup, workspaceLayout } from "../src/workspace-layout.js";

test("发送冻结文字与引用，等待期间的新输入跟随新 session，迟到回执不清空其他草稿", () => {
	const before = {
		goal: "公开火船",
		attachments: [
			{ id: "1", label: "外部笔记", kind: "text" as const, status: "ready" as const, content: "笔记内容" },
		],
	};
	const staged = stageSubmission(before);
	assert.equal(staged.goal, "");
	assert.equal(staged.attachments?.length, 0);
	assert.equal(staged.pending?.text, composerText(before));
	assert.equal(staged.pending?.sessionId, undefined, "没有 session 就是新建");
	let state = updateComposerDraft({ ...DEFAULT_VIEW }, "new", () => staged);
	assert.equal(state.sessionChosen, true);
	assert.equal(state.sessionId, "");
	state = updateComposerDraft(state, "new", (draft) => ({ ...draft, goal: "后续输入" }));
	state = acknowledgeSubmission(state, "new", staged.pending?.id ?? "", "session-1");
	assert.equal(state.sessionId, "session-1");
	assert.equal(state.composerDrafts["session-1"]?.goal, "后续输入");
	assert.equal(state.composerDrafts.new, undefined);
	assert.equal(acknowledgeSubmission(state, "new", staged.pending?.id ?? "", "session-1"), state);
	const switched = { ...updateComposerDraft(state, "new", () => staged), sessionId: "session-other" };
	const late = acknowledgeSubmission(switched, "new", staged.pending?.id ?? "", "session-2");
	assert.equal(late.sessionId, "session-other");
});

test("附件在草稿跟随新 session 后完成，仍回到原附件；移除和重新读取使旧回包失效", () => {
	const staged = stageSubmission({ goal: "目标", attachments: [] });
	const attachment = {
		id: "attachment",
		readId: "read-1",
		label: "选段",
		kind: "selection" as const,
		selection: "原选段",
		status: "reading" as const,
		content: "",
	};
	let state = updateComposerDraft({ ...DEFAULT_VIEW }, "new", () => ({ ...staged, attachments: [attachment] }));
	state = acknowledgeSubmission(state, "new", staged.pending?.id ?? "", "session-1");
	state = settleComposerAttachment(state, { ...attachment, status: "ready", content: "实际选段" });
	assert.equal(state.composerDrafts["session-1"]?.attachments?.[0]?.content, "实际选段");
	assert.equal(state.composerDrafts.new, undefined);
	state = updateComposerDraft(state, "session-1", (draft) => ({
		...draft,
		attachments: [{ ...attachment, readId: "read-2" }],
	}));
	assert.equal(settleComposerAttachment(state, { ...attachment, status: "ready", content: "旧回包" }), state);
	state = updateComposerDraft(state, "session-1", emptyComposer);
	assert.equal(
		settleComposerAttachment(state, { ...attachment, readId: "read-2", status: "ready", content: "迟到回包" }),
		state,
	);
});

test("同一 session 的消息带 sessionId；paused 不收；模型选择只在 turn 边界带上；未读完、失败引用及待确认提交不能再次发送", () => {
	const oversized = {
		goal: "目标",
		attachments: [
			{ id: "huge", label: "大引用", kind: "text" as const, status: "ready" as const, content: "字".repeat(100000) },
		],
	};
	assert.equal(stageSubmission(oversized), oversized);
	const model = { provider: "p", model: "m" };
	for (const status of ["running", "idle"]) {
		const staged = stageSubmission({ goal: "补充", attachments: [], model }, { id: "session-1", status });
		assert.equal(staged.pending?.sessionId, "session-1");
		assert.equal(staged.pending?.model, status === "idle" ? model : undefined, "跑着的时候这次不换模型");
		assert.deepEqual(staged.model, model, "输入框里的选择留到下一轮");
		assert.equal(stageSubmission(staged), staged);
	}
	const paused = { goal: "补充", attachments: [] };
	assert.equal(stageSubmission(paused, { id: "session-1", status: "paused" }), paused);
	for (const status of ["reading", "failed"] as const) {
		const draft = {
			...emptyComposer(),
			goal: "目标",
			attachments: [{ id: "1", kind: "text" as const, label: "未读完", status, content: "" }],
		};
		assert.equal(stageSubmission(draft), draft);
	}
});

test("外部文本真正解码，保留中文；拒绝二进制、未知编码和伪装的非文本文件", async () => {
	assert.match(await textFileAttachment(new File(["中文笔记\n保留换行"], "笔记.md")), /中文笔记\n保留换行/);
	await assert.rejects(textFileAttachment(new File([new Uint8Array([255])], "bad.txt")));
	await assert.rejects(textFileAttachment(new File(["a\0b"], "bad.txt")), /二进制/);
	await assert.rejects(textFileAttachment(new File(["%PDF"], "document.pdf")), /尚未接通/);
	await assert.rejects(textFileAttachment(new File(["x".repeat(256 * 1024 + 1)], "large.md")), /256 KB/);
});

test("发起窗格关闭后，共享输入仍接收发送回执与附件内容", () => {
	let layout = workspaceLayout();
	layout = splitGroup(layout, layout.activeGroup, "horizontal");
	const origin = layout.activeGroup;
	const staged = stageSubmission({ goal: "新对话", attachments: [] });
	const reading = {
		id: "reference",
		readId: "read-1",
		label: "人物",
		kind: "document" as const,
		status: "reading" as const,
		content: "",
	};
	layout = updateComposerDraft(layout, "new", () => ({ ...staged, goal: "后续要求", attachments: [reading] }));
	layout = mergeGroup(layout, origin);
	assert.equal(
		layout.groups.some((group) => group.id === origin),
		false,
	);
	layout = acknowledgeSubmission(layout, "new", staged.pending?.id ?? "", "session-1");
	layout = settleComposerAttachment(layout, { ...reading, status: "ready", content: "人物资料" });
	assert.equal(layout.sessionId, "session-1");
	assert.equal(layout.composerDrafts["session-1"]?.goal, "后续要求");
	assert.equal(layout.composerDrafts["session-1"]?.attachments[0]?.content, "人物资料");
	assert.equal(layout.composerDrafts.new, undefined);
	assert.equal(layout.groups.length, 1);
});
