import assert from "node:assert/strict";
import test from "node:test";
import {
	isSessionActive,
	messageReferences,
	sessionProblem,
	transcriptGroups,
	turnSummaryText,
} from "../src/run-presentation.js";

test("恢复入口由错误码决定，原因文案不改变恢复策略；paused 与 idle 的一句话分开呈现", () => {
	const session = {
		id: "s",
		title: "说明",
		kind: "agent" as const,
		status: "idle" as const,
		turn: 1,
		createdAt: "2026-09-12T00:00:00.000Z",
		updatedAt: "2026-09-12T00:00:00.000Z",
	};
	const unknown = sessionProblem({
		...session,
		status: "paused",
		pause: { code: "model_call_unknown", message: "Request timed out", retryable: false },
	});
	assert.equal(unknown?.unknownModelCall, true);
	assert.equal(unknown?.paused, true);
	assert.equal(unknown?.detail, "Request timed out");
	const stuck = sessionProblem({
		...session,
		lastFailure: { code: "run_no_progress", message: "重复动作", retryable: true },
	});
	assert.equal(stuck?.unknownModelCall, false);
	assert.equal(stuck?.paused, false);
	assert.equal(stuck?.title, "需要调整方向");
	// 两种打转都报 run_no_progress：同一动作同一结果连续三次（成功的也算）、连续五次回复的动作全被拒绝。
	assert.match(stuck?.hint ?? "", /同一个结果/u);
	assert.match(stuck?.hint ?? "", /被拒绝/u);
	const checkpoint = sessionProblem({
		...session,
		lastFailure: { code: "turn_usage_checkpoint", message: "这一轮的用量折合 612 万 token", retryable: false },
	});
	assert.equal(checkpoint?.paused, false, "检查点不是 paused：作者发一条消息就接着跑");
	assert.equal(checkpoint?.title, "到了这一轮的用量检查点");
	assert.equal(checkpoint?.detail, "这一轮的用量折合 612 万 token");
	const other = sessionProblem({
		...session,
		lastFailure: { code: "invalid_reference", message: "未知人物引用", retryable: false },
	});
	assert.equal(other?.title, "这一轮没有正常结束");
	assert.equal(sessionProblem(session), undefined);
	assert.equal(isSessionActive({ ...session, status: "running" }), true);
	assert.equal(isSessionActive(session), false);
});

test("turn 对账：没改作品也没提交就不显示；有改动时一行说清作者几条、意图改没改、各类改了几个、提交与未提交", () => {
	const none = { count: 0, paths: [] };
	const quiet = {
		authorMessages: 1,
		changed: { intent: none, design: none, text: none, review: none, other: none },
		revisions: 0,
		uncommitted: 3,
	};
	assert.equal(turnSummaryText(quiet), undefined, "只讨论的 turn 不加一行噪声；未提交的候选另有入口");
	assert.equal(
		turnSummaryText({
			...quiet,
			changed: {
				...quiet.changed,
				text: { count: 1, paths: ["text/beat-0001.md"] },
				review: { count: 1, paths: ["review/r1.md"] },
			},
			revisions: 2,
			uncommitted: 0,
		}),
		"本轮：作者 1 条 · 意图未改动 · 正文改了 1 个文件 · 审稿改了 1 个文件 · 提交了 2 个版本",
	);
	assert.equal(
		turnSummaryText({
			...quiet,
			authorMessages: 0,
			changed: { ...quiet.changed, intent: { count: 1, paths: ["intent/计谋的代价.md"] } },
			uncommitted: 1,
		}),
		"本轮：意图改了 1 个文件 · 没有提交 · 还有 1 个文件未提交",
	);
	// 2026-10-02 斗破留出评测：根 Agent 三节正文都没取写作依据就自己写了，没人发现
	assert.equal(
		turnSummaryText({
			...quiet,
			changed: { ...quiet.changed, text: { count: 3, paths: ["text/a.md", "text/b.md", "text/c.md"] } },
			uncommitted: 3,
			textWithoutContext: { count: 2, paths: ["text/b.md", "text/c.md"] },
		}),
		"本轮：作者 1 条 · 意图未改动 · 正文改了 3 个文件，其中 2 个没先读取写作依据 · 没有提交 · 还有 3 个文件未提交",
	);
});

test("对话里的动作按执行者成组：子任务的动作不并进根 Agent 的「已执行 N 项」", () => {
	// 2026-10-02 之前所有动作按顺序连成一组：委派一节正文，根 Agent 自己只做了两三件事，却显示「已执行 30 项操作」。
	const action = (id: string, sequence: number, taskId?: string) => ({
		kind: "activity" as const,
		id,
		sequence,
		activity: { id, taskId },
	});
	const groups = transcriptGroups(
		[
			{ kind: "message" as const, id: "m1", sequence: 1 },
			action("read", 2, "session-1"),
			action("writer-read", 3, "task-1"),
			action("writer-write", 4, "task-1"),
			action("delegate", 5, "session-1"),
			action("old-event", 6),
			{ kind: "summary" as const, id: "s1", sequence: 7 },
		],
		"session-1",
	);
	assert.deepEqual(
		groups.map((group) =>
			group.kind === "activities" ? [group.taskId ?? "root", group.rows.map((row) => row.id)] : group.kind,
		),
		[
			"message",
			["root", ["read"]],
			["task-1", ["writer-read", "writer-write"]],
			["root", ["delegate", "old-event"]],
			"summary",
		],
	);
});

test("作者消息里的引用折成标签：原话照常显示，选段带标题与段落位置，修订与内容 SHA 不摊在气泡里", () => {
	const selection =
		"作品引用：text/beat-0002.md\nrevision: aaaa\ncontentSHA: bbbb\n第 3 段选段：\n黄盖在军杖落下前停了一下。\n\n他没有回头。";
	const file =
		"作品引用：intent/计谋的代价.md\n基于版本：aaaa\n内容状态：已提交\n文件内容 SHA-256：cccc\n文件内容：\n全文";
	const attachment = "外部文本附件：赤壁札记.txt\n以下为会话输入，尚未纳入作品。\n\n札记";
	const titles = new Map([["text/beat-0002.md", "苦肉计 · 正文"]]);
	const split = messageReferences(`请修改这一段：压短一半\n\n${selection}\n\n${file}\n\n${attachment}`, (path) =>
		titles.get(path),
	);
	assert.equal(split.body, "请修改这一段：压短一半");
	assert.deepEqual(
		split.references.map((item) => item.label),
		["苦肉计 · 正文 · 第 3 段选段", "intent/计谋的代价.md", "赤壁札记.txt"],
	);
	assert.equal(split.references[0]?.content, selection, "选段里自己的空行不切断引用");
	assert.deepEqual(
		split.references.map((item) => item.quote),
		["黄盖在军杖落下前停了一下。\n\n他没有回头。", "全文", "札记"],
		"展开时只看引用的文字，不看版本与 SHA",
	);
	assert.deepEqual(messageReferences("只有一句话\n\n作品之外的引号：不算", () => undefined).references, []);
	assert.equal(messageReferences(`${selection}`, (path) => titles.get(path)).body, "", "只有引用时原话为空");
});
