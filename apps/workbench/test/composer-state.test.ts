import assert from "node:assert/strict";
import test from "node:test";
import {
	acknowledgeSubmission,
	type ComposerState,
	composerText,
	emptyComposer,
	restoreComposerDrafts,
	settleComposerAttachment,
	stageSubmission,
	textFileAttachment,
	updateComposerDraft,
} from "../src/composer-state.js";
import { DEFAULT_VIEW } from "../src/view-state.js";
import { mergeGroup, splitGroup, workspaceLayout } from "../src/workspace-layout.js";

test("发送冻结文字与引用，等待期间的新输入跟随新 session，迟到回执不清空其他草稿", () => {
	const before = {
		goal: "诈降",
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

test("同一 session 的消息带 sessionId；模型选择只在 turn 边界带上；未读完、失败引用及待确认提交不能再次发送", () => {
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
	for (const status of ["reading", "failed"] as const) {
		const draft = {
			...emptyComposer(),
			goal: "目标",
			attachments: [{ id: "1", kind: "text" as const, label: "未读完", status, content: "" }],
		};
		assert.equal(stageSubmission(draft), draft);
	}
});

test("讨论开关与模型一样只在 turn 边界带上；与对话当前设置相同时不带", () => {
	for (const status of ["running", "idle"]) {
		const staged = stageSubmission({ goal: "先聊聊", attachments: [], discuss: true }, { id: "session-1", status });
		assert.equal(staged.pending?.discuss, status === "idle" ? true : undefined, "跑着的时候这次不开关讨论");
		assert.equal(staged.discuss, true, "输入框里的选择留到下一轮");
	}
	const same = stageSubmission(
		{ goal: "接着聊", attachments: [], discuss: true },
		{ id: "session-1", status: "idle", discuss: true },
	);
	assert.equal(same.pending?.discuss, undefined);
	const closing = stageSubmission(
		{ goal: "照这个做", attachments: [], discuss: false },
		{ id: "session-1", status: "idle", discuss: true },
	);
	assert.equal(closing.pending?.discuss, false, "关上讨论要明确带 false");
	const fresh = stageSubmission({ goal: "新对话", attachments: [], discuss: false });
	assert.equal(fresh.pending?.discuss, undefined, "新对话默认就关着");
	assert.equal(stageSubmission({ goal: "新对话先讨论", attachments: [], discuss: true }).pending?.discuss, true);
	// 只开了讨论、还没输入也要留着（与只选了模型相同）；重载恢复不丢
	const empty: ComposerState = { sessionId: "", sessionChosen: false, composerDrafts: {} };
	const state = updateComposerDraft(empty, "new", (draft) => ({ ...draft, discuss: true }));
	assert.equal(state.composerDrafts.new?.discuss, true);
	assert.equal(restoreComposerDrafts(JSON.parse(JSON.stringify(state.composerDrafts))).new?.discuss, true);
	assert.throws(() => restoreComposerDrafts({ new: { goal: "", attachments: [], discuss: "yes" } }), /不完整/);
	// 选了 /目标 还没写的草稿也留着，重载后仍在目标输入里；发出后回到普通输入
	const goal = updateComposerDraft(empty, "new", (draft) => ({ ...draft, goalMode: true }));
	assert.equal(restoreComposerDrafts(JSON.parse(JSON.stringify(goal.composerDrafts))).new?.goalMode, true);
	assert.equal(
		stageSubmission({ goal: "写完第二卷", attachments: [], goalMode: true }, undefined, undefined, { goal: true })
			.goalMode,
		undefined,
	);
	assert.throws(() => restoreComposerDrafts({ new: { goal: "", attachments: [], goalMode: "yes" } }), /不完整/);
	// 2026-10-19 之前的草稿存的是三档的 mode：当作未知辅助字段丢掉，草稿照常恢复
	const legacy = restoreComposerDrafts({ new: { goal: "旧草稿", attachments: [], mode: "collaborate" } });
	assert.deepEqual(legacy.new, { goal: "旧草稿", attachments: [] });
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

test("明确拒绝只退回本次发送，保留等待期间的补充与引用；迟到拒绝不动其他提交", async () => {
	const { rejectSubmission } = await import("../src/composer-state.js");
	const original = {
		goal: "原要求",
		attachments: [{ id: "a", label: "原引用", kind: "text" as const, status: "ready" as const, content: "原文" }],
	};
	const staged = stageSubmission(original);
	const id = staged.pending?.id ?? "";
	const attachment = original.attachments[0];
	assert.ok(attachment);
	const current = { ...staged, goal: "补充要求", attachments: [{ ...attachment, id: "b" }] };
	const restored = rejectSubmission(current, id, original);
	assert.equal(restored.goal, "原要求\n\n补充要求");
	assert.deepEqual(
		restored.attachments.map((a) => a.id),
		["a", "b"],
	);
	assert.equal(restored.pending, undefined);
	assert.equal(rejectSubmission(current, "other", original), current);
});
