import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionStateError, InMemoryExecutionState, type ModelBindingSnapshot } from "../src/index.js";

const modelBinding: ModelBindingSnapshot = {
	modelProfileId: "main",
	routingVersion: `sha256:${"a".repeat(64)}`,
	provider: "provider-a",
	model: "model-a",
	api: "openai-completions",
	baseUrl: "https://example.invalid/v1",
	credentialSource: "stored credential",
	credentialType: "api_key",
	options: { maxTokens: 8192 },
};

const lease = { ownerId: "owner-1", pid: 1, hostname: "local", acquiredAt: "2026-09-03T00:00:00.000Z" };

function state(): InMemoryExecutionState {
	return new InMemoryExecutionState({ now: () => new Date("2026-09-03T00:00:00.000Z") });
}

function createSession(execution: InMemoryExecutionState, suffix = "1"): void {
	execution.createSession({
		commandId: `create-session-${suffix}`,
		id: `session-${suffix}`,
		projectId: "project-1",
		model: modelBinding,
		baseRevisionId: "revision-base",
	});
}

test("session 只有 idle / running / paused：turn 开始拿 lease，模型停下回 idle", () => {
	const execution = state();
	createSession(execution);
	assert.equal(execution.session("session-1").status, "idle");
	const started = execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	assert.equal(started.status, "running");
	assert.equal(started.turn, 1);
	assert.equal(started.turnId, "owner-1");
	execution.recordSessionCheckpoint("checkpoint-1", "session-1", { kind: "object", id: "checkpoint-object" }, 1);
	assert.equal(execution.session("session-1").inboxSequence, 1);
	const ended = execution.endTurn({ commandId: "end-1", sessionId: "session-1", status: "idle" });
	assert.equal(ended.status, "idle");
	assert.equal(ended.lease, undefined);
	assert.equal(ended.turnId, "owner-1", "turn id 留给事件恢复与归因");
});

test("paused 只能显式 resume；idle 上的 lastFailure 在下一个 turn 开始时清掉", () => {
	const execution = state();
	createSession(execution);
	execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	assert.throws(
		() => execution.endTurn({ commandId: "end-bad", sessionId: "session-1", status: "paused" }),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "invalid_execution_input",
	);
	const paused = execution.endTurn({
		commandId: "end-1",
		sessionId: "session-1",
		status: "paused",
		failure: { code: "model_call_unknown", message: "结果未知", retryable: true },
	});
	assert.equal(paused.status, "paused");
	assert.equal(paused.pause?.code, "model_call_unknown");
	assert.throws(
		() => execution.startTurn({ commandId: "turn-2", sessionId: "session-1", lease }),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "session_paused",
	);
	const resumed = execution.startTurn({ commandId: "turn-2", sessionId: "session-1", lease, fromPaused: true });
	assert.equal(resumed.status, "running");
	assert.equal(resumed.pause, undefined);
	const idle = execution.endTurn({
		commandId: "end-2",
		sessionId: "session-1",
		status: "idle",
		failure: { code: "run_no_progress", message: "重复动作", retryable: true },
	});
	assert.equal(idle.lastFailure?.code, "run_no_progress");
	assert.equal(execution.startTurn({ commandId: "turn-3", sessionId: "session-1", lease }).lastFailure, undefined);
	assert.throws(
		() => execution.startTurn({ commandId: "turn-4", sessionId: "session-1", lease }),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "session_running",
	);
});

test("子任务只能在 running 的 turn 里建；turn 结束把还在跑的子任务标 interrupted，续跑接着来", () => {
	const execution = state();
	createSession(execution);
	assert.throws(
		() =>
			execution.addTask({
				commandId: "task-early",
				id: "task-1",
				sessionId: "session-1",
				kind: "main",
				key: "a",
			}),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "invalid_execution_transition",
	);
	execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	const task = execution.addTask({
		commandId: "task-1",
		id: "task-1",
		sessionId: "session-1",
		kind: "main",
		key: "action-1",
		parent: { actionId: "action-1" },
		model: modelBinding,
	});
	assert.equal(task.status, "running");
	assert.throws(
		() =>
			execution.addTask({
				commandId: "task-dup",
				id: "task-2",
				sessionId: "session-1",
				kind: "main",
				key: "action-1",
			}),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "execution_conflict",
	);
	execution.recordTaskCheckpoint("task-checkpoint", "task-1", { kind: "object", id: "task-object" });
	execution.recordTaskUsage({
		commandId: "task-usage",
		taskId: "task-1",
		usage: {
			calls: 1,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 15,
			costUsd: 0.01,
		},
	});
	assert.equal(execution.session("session-1").usage?.totalTokens, 15, "子任务用量累计到 session");
	execution.endTurn({ commandId: "end-1", sessionId: "session-1", status: "idle" });
	assert.equal(execution.task("task-1").status, "interrupted");
	execution.startTurn({ commandId: "turn-2", sessionId: "session-1", lease });
	assert.equal(execution.resumeTask("task-resume", "task-1").status, "running");
	const completed = execution.completeTask("task-complete", "task-1", { kind: "object", id: "result-object" });
	assert.equal(completed.status, "completed");
	assert.deepEqual(
		execution.tasksOf("session-1").map((item) => item.id),
		["task-1"],
	);
	assert.throws(
		() =>
			execution.failTask({
				commandId: "task-fail",
				taskId: "task-1",
				failure: { code: "x", message: "late", retryable: false },
			}),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "invalid_execution_transition",
	);
});

test("进程恢复把持有者已死的 running session 收敛回 idle 并记一句，子任务标 interrupted", () => {
	const before = state();
	createSession(before);
	before.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	before.addTask({ commandId: "task-1", id: "task-1", sessionId: "session-1", kind: "main", key: "a" });
	before.recordSessionCheckpoint("checkpoint-1", "session-1", { kind: "object", id: "checkpoint-object" }, 1);

	const restored = new InMemoryExecutionState({
		now: () => new Date("2026-09-03T01:00:00.000Z"),
		snapshot: before.exportSnapshot(),
	});
	assert.deepEqual(restored.recoverUnfinished("recover-1", { holderAlive: () => true }), { recoveredSessionIds: [] });
	assert.equal(restored.session("session-1").status, "running", "持有进程还活着的不是崩溃遗留");
	const recovered = restored.recoverUnfinished("recover-2");
	assert.deepEqual(recovered, { recoveredSessionIds: ["session-1"] });
	const session = restored.session("session-1");
	assert.equal(session.status, "idle");
	assert.equal(session.lease, undefined);
	assert.equal(session.lastFailure?.code, "process_restart");
	assert.deepEqual(
		session.checkpointRef,
		{ kind: "object", id: "checkpoint-object" },
		"checkpoint 保留，下一个 turn 从它续",
	);
	assert.equal(restored.task("task-1").status, "interrupted");
	assert.deepEqual(restored.recoverUnfinished("recover-2"), recovered);
});

test("删除 session 带走它的子任务；turn 进行中不能删", () => {
	// 换模型没有单独的命令（Harness 设计第 10 节）：新模型随 session.send 给，在 turn 边界由 startTurn 换绑。
	const execution = state();
	createSession(execution);
	execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	execution.addTask({ commandId: "task-1", id: "task-1", sessionId: "session-1", kind: "main", key: "a" });
	assert.throws(
		() => execution.deleteSession("delete-early", "session-1"),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "session_running",
	);
	execution.endTurn({ commandId: "end-1", sessionId: "session-1", status: "idle" });
	execution.deleteSession("delete-1", "session-1");
	assert.throws(() => execution.session("session-1"), ExecutionStateError);
	assert.throws(() => execution.task("task-1"), ExecutionStateError);
	assert.deepEqual(execution.exportSnapshot().tasks, []);
});

test("用量逐次累计并随快照恢复；非法数字原子回滚", () => {
	const execution = state();
	createSession(execution);
	execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	const first = {
		calls: 1,
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 10,
		totalTokens: 150,
		costUsd: 0.01,
	};
	const second = {
		calls: 1,
		input: 200,
		output: 60,
		cacheRead: 20,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 280,
		costUsd: 0.02,
	};
	execution.recordSessionUsage({ commandId: "usage-1", sessionId: "session-1", usage: first });
	const session = execution.recordSessionUsage({ commandId: "usage-2", sessionId: "session-1", usage: second });
	assert.deepEqual(
		{ ...session.usage, costUsd: Number(session.usage?.costUsd.toFixed(6)) },
		{
			calls: 2,
			input: 300,
			output: 110,
			cacheRead: 20,
			cacheWrite: 0,
			reasoning: 10,
			totalTokens: 430,
			costUsd: 0.03,
		},
	);
	const restored = new InMemoryExecutionState({ snapshot: execution.exportSnapshot() });
	assert.equal(restored.session("session-1").usage?.totalTokens, 430);
	const before = execution.exportSnapshot();
	assert.throws(
		() =>
			execution.recordSessionUsage({
				commandId: "usage-3",
				sessionId: "session-1",
				usage: { ...first, costUsd: Number.NaN },
			}),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "invalid_execution_input",
	);
	assert.deepEqual(execution.exportSnapshot(), before);
});

test("command id 冲突不能静默越过；同一命令同一输入幂等返回原结果", () => {
	const execution = state();
	createSession(execution);
	const first = execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease });
	assert.deepEqual(execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease }), first);
	assert.throws(
		() => execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease: { ...lease, ownerId: "other" } }),
		(error: unknown) => error instanceof ExecutionStateError && error.code === "duplicate_command_conflict",
	);
});

test("持久确认失败回滚命令，并禁止该实例继续推进", () => {
	const error = new Error("disk write failed");
	let rejectCommit = false;
	const execution = new InMemoryExecutionState({
		commit: () => {
			if (rejectCommit) throw error;
		},
	});
	createSession(execution);
	const before = execution.exportSnapshot();
	rejectCommit = true;
	assert.throws(
		() => execution.startTurn({ commandId: "turn-1", sessionId: "session-1", lease }),
		(actual) => actual === error,
	);
	assert.deepEqual(execution.exportSnapshot(), before);
	rejectCommit = false;
	assert.throws(
		() => execution.startTurn({ commandId: "turn-2", sessionId: "session-1", lease }),
		(actual) => actual === error,
	);
});
