import assert from "node:assert/strict";
import test from "node:test";
import {
	actionRuns,
	isSessionActive,
	messageReferences,
	sessionProblem,
	taskRoleLabel,
	transcriptGroups,
	turnSummaryText,
} from "../src/run-presentation.js";

test("子任务按角色显示名称，与设置页的档位名一致；10-05 之前按入口记的旧记录照样认得", () => {
	// 原来 kind 是 subagent / review / rank.round：三种都是子智能体，subagent 说的却是类别本身，写手、读原作、抽取都叫「子任务」。
	assert.deepEqual(["writer", "source-extractor", "source-reader", "reviewer", "judge", "main"].map(taskRoleLabel), [
		"正文写作",
		"原作抽取",
		"原作阅读",
		"独立审稿",
		"评委",
		"子任务",
	]);
	assert.deepEqual(["subagent", "review", "rank.round"].map(taskRoleLabel), ["子任务", "独立审稿", "评委"]);
	assert.equal(taskRoleLabel(undefined), "子任务");
});

test("这一轮没正常结束时说什么由错误码决定，原因原文放在详情里", () => {
	const session = {
		id: "s",
		title: "说明",
		kind: "agent" as const,
		status: "idle" as const,
		turn: 1,
		createdAt: "2026-09-12T00:00:00.000Z",
		updatedAt: "2026-09-12T00:00:00.000Z",
	};
	const failed = sessionProblem({
		...session,
		lastFailure: { code: "model_call_failed", message: "Request timed out", retryable: false },
	});
	assert.equal(failed?.title, "模型调用失败");
	assert.equal(failed?.detail, "Request timed out");
	const stuck = sessionProblem({
		...session,
		lastFailure: { code: "run_no_progress", message: "重复动作", retryable: true },
	});
	assert.equal(stuck?.title, "需要调整方向");
	// 两种打转都报 run_no_progress：同一动作同一结果连续三次（成功的也算）、连续五次回复的动作全被拒绝。
	assert.match(stuck?.hint ?? "", /同一个结果/u);
	assert.match(stuck?.hint ?? "", /被拒绝/u);
	const checkpoint = sessionProblem({
		...session,
		lastFailure: { code: "turn_usage_checkpoint", message: "这一轮的用量折合 612 万 token", retryable: false },
	});
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
	// 作者按了停止：什么都没改也说一声，有改动时放在对账前面
	assert.equal(turnSummaryText({ ...quiet, stopped: true }), "已停止");
	assert.equal(
		turnSummaryText({
			...quiet,
			stopped: true,
			changed: { ...quiet.changed, text: { count: 1, paths: ["text/beat-0001.md"] } },
			uncommitted: 1,
		}),
		"已停止 · 本轮：作者 1 条 · 意图未改动 · 正文改了 1 个文件 · 没有提交 · 还有 1 个文件未提交",
	);
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

test("并行的子任务动作交错到达时，同一段里按子任务各成一组，不在每次换任务时断开", () => {
	// 2026-10-06 作者在斗破 120 章那次对话里看到几百行「子任务执行了 1 项操作」：16 个子任务并行，
	// 动作在事件流里交错，原来只把相邻的同一子任务并成一组，几乎每个动作自成一组。
	const action = (id: string, sequence: number, taskId?: string) => ({
		kind: "activity" as const,
		id,
		sequence,
		activity: { id, taskId },
	});
	const groups = transcriptGroups(
		[
			{ kind: "message" as const, id: "m1", sequence: 1 },
			action("delegate", 2, "session-1"),
			action("a", 3, "task-1"),
			action("b", 4, "task-2"),
			action("c", 5, "task-1"),
			action("d", 6, "task-3"),
			action("e", 7, "task-2"),
			action("commit", 8, "session-1"),
			action("f", 9, "task-1"),
			{ kind: "message" as const, id: "m2", sequence: 10 },
			action("g", 11, "task-2"),
		],
		"session-1",
	);
	assert.deepEqual(
		groups.map((group) =>
			group.kind === "activities" ? [group.taskId ?? "root", group.rows.map((row) => row.id)] : group.kind,
		),
		[
			"message",
			["root", ["delegate"]],
			["task-1", ["a", "c"]],
			["task-2", ["b", "e"]],
			["task-3", ["d"]],
			// 根 Agent 的动作是时间上的分界：子任务都做完之后的提交仍排在它们后面，之后再来的动作另起一组。
			["root", ["commit"]],
			["task-1", ["f"]],
			"message",
			["task-2", ["g"]],
		],
	);
});

test("组内连续的同类动作并成一行：读了 12 个文件是一行「读取文件 12 次」，展开再看每一个", () => {
	const row = (id: string, label: string, status = "completed") => ({ id, label, status });
	assert.deepEqual(
		actionRuns([
			row("1", "read"),
			row("2", "read"),
			row("3", "read", "failed"),
			row("4", "write"),
			row("5", "read"),
		]).map((run) => [run.label, run.rows.map((item) => item.id), run.failed]),
		[
			["read", ["1", "2", "3"], 1],
			["write", ["4"], 0],
			["read", ["5"], 0],
		],
	);
	const shown: Record<string, string> = { write: "修改文件", edit: "修改文件" };
	assert.deepEqual(
		actionRuns([row("1", "write"), row("2", "edit")], (item) => shown[item.label] ?? item.label).map((run) => [
			run.label,
			run.rows.length,
		]),
		[["修改文件", 2]],
		"显示成同一个名字的并在一起",
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
