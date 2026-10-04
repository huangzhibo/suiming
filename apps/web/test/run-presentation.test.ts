import assert from "node:assert/strict";
import test from "node:test";
import { isSessionActive, sessionProblem, transcriptGroups, turnSummaryText } from "../src/run-presentation.js";

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
