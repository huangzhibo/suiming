import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EventType } from "@suiming/sdk";
import { ArtifactError, type InMemoryExecutionState, SqliteLocalStore } from "../src/index.js";

const now = () => new Date("2026-09-08T00:00:00Z");
const lease = { ownerId: "owner-1", pid: process.pid, hostname: "local", acquiredAt: now().toISOString() };

async function fixture(
	body: (store: SqliteLocalStore, databasePath: string, reopen: () => SqliteLocalStore) => void,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "suiming-execution-tx-"));
	const databasePath = join(root, "local.sqlite");
	const stores: SqliteLocalStore[] = [];
	const reopen = () => {
		const store = new SqliteLocalStore({ databasePath, objectRootPath: join(root, "objects"), now });
		stores.push(store);
		return store;
	};
	try {
		const store = reopen();
		store.createProject({ projectId: "project", checkoutPath: join(root, "checkout") });
		body(store, databasePath, reopen);
	} finally {
		for (const store of stores) store.close();
		await rm(root, { recursive: true, force: true });
	}
}

function execution(store: SqliteLocalStore): InMemoryExecutionState {
	return store.createExecutionState({ now });
}

function createSession(state: InMemoryExecutionState, suffix: string): void {
	state.createSession({ commandId: `session:${suffix}`, id: `session-${suffix}`, projectId: "project" });
}

test("SQLite 双连接各自新建 session：两边的都留下，后写的不抹掉先写的", async () => {
	// 每条命令只写自己改动的行（applyExecutionDelta）；整份快照写入那条路 2026-10-02 已删。
	await fixture((store, _databasePath, reopen) => {
		createSession(execution(store), "a");
		createSession(execution(reopen()), "b");
		assert.deepEqual(
			store
				.loadExecutionEntities()
				.sessions.map((session) => session.id)
				.sort(),
			["session-a", "session-b"],
		);
	});
});

test("SQLite 双连接修改独立 session 不因快照中无关实体过时而冲突", async () => {
	await fixture((store, _databasePath, reopen) => {
		const initial = execution(store);
		createSession(initial, "a");
		createSession(initial, "b");
		const first = execution(store);
		const second = execution(reopen());
		first.startTurn({ commandId: "start:a", sessionId: "session-a", lease });
		second.startTurn({ commandId: "start:b", sessionId: "session-b", lease });
		assert.deepEqual(
			store.loadExecutionEntities().sessions.map((session) => session.status),
			["running", "running"],
		);
		// 第二个连接已经前进到相同版本；相同目标内容也不能冒充这次陈旧命令成功。
		assert.throws(
			() => first.startTurn({ commandId: "stale:b", sessionId: "session-b", lease }),
			(error) => error instanceof ArtifactError && error.code === "execution_state_conflict",
		);
		assert.equal(first.session("session-b").status, "idle");
	});
});

test("SQLite 在同一个读事务里加载执行快照，并发提交不能混入后半次读取", async (t) => {
	await fixture((store, _databasePath, reopen) => {
		createSession(execution(store), "a");
		const writer = execution(reopen());
		const prepare = DatabaseSync.prototype.prepare;
		let interleaved = false;
		t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, statement: string) {
			const prepared = prepare.call(this, statement);
			if (statement === "SELECT data_json FROM sessions ORDER BY id" && !interleaved) {
				const all = prepared.all.bind(prepared);
				t.mock.method(prepared, "all", () => {
					const rows = all();
					interleaved = true;
					writer.startTurn({ commandId: "interleaved-start", sessionId: "session-a", lease });
					writer.addTask({
						commandId: "interleaved-task",
						id: "task",
						sessionId: "session-a",
						kind: "main",
						key: "a",
					});
					return rows;
				});
			}
			return prepared;
		});
		const snapshot = store.loadExecutionEntities();
		assert.equal(interleaved, true);
		assert.equal(snapshot.sessions[0]?.status, "idle");
		assert.deepEqual(snapshot.tasks, [], "后读的 task 与先读的 session 是同一时刻的");
		assert.equal(store.loadExecutionEntities().sessions[0]?.status, "running");
	});
});

test("SQLite 同 id、同版本的并发新建必须冲突，不能仅比较版本数字", async () => {
	await fixture((store, _databasePath, reopen) => {
		const first = execution(store);
		const second = execution(reopen());
		first.createSession({ commandId: "first", id: "same", projectId: "project" });
		assert.throws(
			() => second.createSession({ commandId: "second", id: "same", projectId: "project" }),
			(error) => error instanceof ArtifactError && error.code === "execution_state_conflict",
		);
		assert.ok(store.readCommandReceipt("first"));
		assert.equal(store.readCommandReceipt("second"), undefined);
		assert.equal(second.exportSnapshot().sessions.length, 0);
	});
});

test("SQLite command id 跨连接冲突时不能写入新实体或覆盖原回执", async (t) => {
	await fixture((store, _databasePath, reopen) => {
		const first = execution(store);
		const secondStore = reopen();
		const second = execution(secondStore);
		first.createSession({ commandId: "same-command", id: "first", projectId: "project" });
		// 回执按 id 点查，执行前就看得到另一个连接刚写的那条
		assert.throws(
			() => second.createSession({ commandId: "same-command", id: "second", projectId: "project" }),
			(error) => (error as { code?: string }).code === "duplicate_command_conflict",
		);
		// 查的时候还没有、提交前另一个连接写进去了：落库那一步照样拦下
		t.mock.method(secondStore, "readCommandReceipt", () => undefined);
		assert.throws(
			() => execution(secondStore).createSession({ commandId: "same-command", id: "third", projectId: "project" }),
			(error) => error instanceof ArtifactError && error.code === "duplicate_command_conflict",
		);
		assert.deepEqual(
			store.loadExecutionEntities().sessions.map((session) => session.id),
			["first"],
		);
	});
});

test("SQLite 回执写入失败回滚同事务的 Task，重新加载后可以重试", async () => {
	await fixture((store, databasePath, reopen) => {
		const state = execution(store);
		createSession(state, "a");
		state.startTurn({ commandId: "start", sessionId: "session-a", lease });
		const injector = new DatabaseSync(databasePath);
		try {
			injector.exec(
				"CREATE TRIGGER fail_receipt BEFORE INSERT ON execution_command_receipts WHEN NEW.command_id = 'task' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END",
			);
			assert.throws(
				() => state.addTask({ commandId: "task", id: "task", sessionId: "session-a", kind: "main", key: "a" }),
				/injected write failure/u,
			);
			assert.equal(store.loadExecutionEntities().tasks.length, 0);
			assert.equal(store.readCommandReceipt("task"), undefined);
			injector.exec("DROP TRIGGER fail_receipt");
			const restored = execution(reopen());
			assert.equal(
				restored.addTask({ commandId: "task", id: "task", sessionId: "session-a", kind: "main", key: "a" }).status,
				"running",
			);
		} finally {
			injector.close();
		}
	});
});

test("SQLite 已提交但确认返回丢失时，旧实例停下，重开从原回执恢复", async () => {
	await fixture((store, _databasePath, reopen) => {
		createSession(execution(store), "a");
		const state = store.createExecutionState({
			now,
			commit: (delta) => {
				store.applyExecutionDelta(delta);
				throw new Error("confirmation lost");
			},
		});
		assert.throws(() => state.startTurn({ commandId: "start", sessionId: "session-a", lease }), /confirmation lost/u);
		assert.equal(state.session("session-a").status, "idle");
		const restored = execution(reopen());
		const version = restored.session("session-a").version;
		assert.equal(restored.startTurn({ commandId: "start", sessionId: "session-a", lease }).status, "running");
		assert.equal(restored.session("session-a").version, version);
	});
});

test("构造执行状态不把命令回执整份读进来：回执只按 id 点查，重放仍拿回原结果、换了输入仍是冲突", async (t) => {
	// 回执每条命令一条、从不清理，2026-10-07 三国作品上 9,108 条：原来每次构造执行状态都整份读进内存（约 160 ms），
	// 作者发一句话要构造四次。
	await fixture((store, _databasePath, reopen) => {
		const state = execution(store);
		createSession(state, "a");
		state.startTurn({ commandId: "start", sessionId: "session-a", lease });
		const prepare = DatabaseSync.prototype.prepare;
		const reads: string[] = [];
		t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, statement: string) {
			if (/^\s*SELECT\b/iu.test(statement) && statement.includes("execution_command_receipts"))
				reads.push(statement);
			return prepare.call(this, statement);
		});
		const restored = execution(reopen());
		assert.deepEqual(reads, [], "构造时不读回执");
		const version = restored.session("session-a").version;
		assert.equal(restored.startTurn({ commandId: "start", sessionId: "session-a", lease }).status, "running");
		assert.equal(restored.session("session-a").version, version, "重放不再执行一次");
		assert.throws(
			() =>
				restored.startTurn({ commandId: "start", sessionId: "session-a", lease: { ...lease, ownerId: "owner-2" } }),
			(error) => error instanceof Error && (error as { code?: string }).code === "duplicate_command_conflict",
		);
		assert.ok(reads.length > 0);
		for (const statement of reads) assert.match(statement, /WHERE command_id = \?/u);
	});
});

test("SQLite 删除 session 时把子任务、inbox 与事件一起删", async () => {
	await fixture((store) => {
		const state = execution(store);
		createSession(state, "a");
		store.queueInbox("session-a", "第一句");
		state.startTurn({ commandId: "start", sessionId: "session-a", lease });
		state.addTask({ commandId: "task", id: "task", sessionId: "session-a", kind: "main", key: "a" });
		store.appendSessionEvents([
			{
				sessionId: "session-a",
				sequence: 1,
				at: now().toISOString(),
				id: "event-1",
				event: { type: EventType.RUN_STARTED, threadId: "session-a", runId: "owner-1" },
			},
		]);
		state.endTurn({ commandId: "end", sessionId: "session-a" });
		state.deleteSession("delete", "session-a");
		const persisted = store.loadExecutionEntities();
		assert.deepEqual(persisted.sessions, []);
		assert.deepEqual(persisted.tasks, []);
		assert.deepEqual(store.readInbox("session-a"), []);
		assert.deepEqual(store.readSessionEvents("session-a"), []);
		assert.throws(
			() => store.queueInbox("session-a", "已删的 session 不收"),
			(error) => error instanceof ArtifactError && error.code === "execution_not_found",
		);
	});
});

test("SQLite 同一事件序号内容冲突使整个事件批次回滚", async () => {
	await fixture((store) => {
		createSession(execution(store), "a");
		const event = {
			sessionId: "session-a",
			sequence: 1,
			at: now().toISOString(),
			id: "event-1",
			event: { type: EventType.RUN_STARTED as const, threadId: "session-a", runId: "turn-1" },
		};
		store.appendSessionEvents([event]);
		store.appendSessionEvents([event]);
		assert.throws(
			() =>
				store.appendSessionEvents([
					{ ...event, sequence: 2 },
					{ ...event, event: { ...event.event, runId: "different" } },
				]),
			(error) => error instanceof ArtifactError && error.code === "session_event_conflict",
		);
		assert.deepEqual(store.readSessionEvents("session-a"), [event]);
	});
});

test("inbox：idle 与 running 都排队，turn 非正常结束后照样收，相同命令返回原序号", async () => {
	await fixture((store) => {
		const state = execution(store);
		createSession(state, "a");
		assert.deepEqual(store.queueInbox("session-a", "第一句", "cmd-1"), { sequence: 1 });
		assert.deepEqual(store.queueInbox("session-a", "第一句", "cmd-1"), { sequence: 1 });
		assert.throws(
			() => store.queueInbox("session-a", "改了内容", "cmd-1"),
			(error) => error instanceof ArtifactError && error.code === "command_conflict",
		);
		state.startTurn({ commandId: "start", sessionId: "session-a", lease });
		assert.deepEqual(store.queueInbox("session-a", "跑着也能排"), { sequence: 2 });
		state.endTurn({
			commandId: "end",
			sessionId: "session-a",
			failure: { code: "model_call_failed", message: "模型调用失败", retryable: true },
		});
		assert.deepEqual(store.queueInbox("session-a", "继续"), { sequence: 3 });
		assert.deepEqual(
			store.readInbox("session-a").map((item) => item.text),
			["第一句", "跑着也能排", "继续"],
		);
	});
});
