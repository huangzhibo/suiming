import { canonicalJson, sha256Hex } from "@suiming/story";
import type { ModelBindingSnapshot } from "../model/model-gateway.js";
import { ExecutionStateError } from "./errors.js";
import { addModelUsage } from "./model-usage.js";
import type {
	ExecutionCommandReceipt,
	ExecutionEntitySnapshot,
	ExecutionEntityType,
	ExecutionFailure,
	ExecutionRecoveryResult,
	ExecutionResultReference,
	ExecutionStateDelta,
	ExecutionStateSnapshot,
	ModelUsage,
	SessionKind,
	SessionLease,
	SessionRecord,
	TaskRecord,
} from "./types.js";

export interface InMemoryExecutionStateOptions {
	now?: () => Date;
	snapshot?: ExecutionStateSnapshot;
	/**
	 * 同步确认这条命令的写集合（改动的实体与回执）；成功返回后才发布通知、允许下一条命令。
	 * 只交改动的那几行：整份快照的成本随项目历史增长。
	 */
	commit?: (delta: ExecutionStateDelta) => void;
}

export interface CreateSessionInput {
	commandId: string;
	id: string;
	projectId: string;
	kind?: SessionKind;
	model?: ModelBindingSnapshot;
	baseRevisionId?: string;
}

export interface StartTurnInput {
	commandId: string;
	sessionId: string;
	lease: SessionLease;
	/** 本 turn 的 AG-UI runId；缺省用 lease.ownerId。 */
	turnId?: string;
	/** 从这个 turn 起换用的模型。 */
	model?: ModelBindingSnapshot;
}

export interface EndTurnInput {
	commandId: string;
	sessionId: string;
	/** turn 非正常结束的原因，记为 lastFailure；作者一句话就能续。 */
	failure?: ExecutionFailure;
}

export interface AddTaskInput {
	commandId: string;
	id: string;
	sessionId: string;
	kind: string;
	key: string;
	parent?: { taskId?: string; actionId: string };
	title?: string;
	model?: ModelBindingSnapshot;
}

export interface FailTaskInput {
	commandId: string;
	taskId: string;
	failure: ExecutionFailure;
}

export interface RecordUsageInput {
	commandId: string;
	/** 单次模型调用的用量；累计由这里完成。 */
	usage: ModelUsage;
}

type ChangedEntity = { type: ExecutionEntityType; snapshot: ExecutionEntitySnapshot };

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new ExecutionStateError("invalid_execution_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function failure(value: ExecutionFailure): ExecutionFailure {
	return {
		code: nonempty(value.code, "failure.code"),
		message: nonempty(value.message, "failure.message"),
		retryable: value.retryable,
	};
}

function nonnegative(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new ExecutionStateError("invalid_execution_input", `${label} must be a finite non-negative number`);
	}
	return value;
}

function usage(value: ModelUsage): ModelUsage {
	return {
		calls: nonnegative(value.calls, "usage.calls"),
		...(value.confirmedCalls === undefined
			? {}
			: { confirmedCalls: nonnegative(value.confirmedCalls, "usage.confirmedCalls") }),
		input: nonnegative(value.input, "usage.input"),
		output: nonnegative(value.output, "usage.output"),
		cacheRead: nonnegative(value.cacheRead, "usage.cacheRead"),
		cacheWrite: nonnegative(value.cacheWrite, "usage.cacheWrite"),
		reasoning: nonnegative(value.reasoning, "usage.reasoning"),
		totalTokens: nonnegative(value.totalTokens, "usage.totalTokens"),
		costUsd: nonnegative(value.costUsd, "usage.costUsd"),
	};
}

function resultReference(value: ExecutionResultReference): ExecutionResultReference {
	return { kind: "object", id: nonempty(value.id, "result.id") };
}

function commandFingerprint(payload: unknown): string {
	return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

function touch(record: { updatedAt: string; version: number }, timestamp: string): void {
	record.updatedAt = timestamp;
	record.version += 1;
}

/**
 * 执行状态的内存形态与全部状态转换。每条命令带 commandId：相同命令相同输入幂等返回原结果，
 * 不同输入报冲突；持久化（`commit`）失败时回滚内存并禁止该实例继续推进。
 */
export class InMemoryExecutionState {
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #tasks = new Map<string, TaskRecord>();
	readonly #receipts = new Map<string, ExecutionCommandReceipt>();
	readonly #now: () => Date;
	readonly #commit: InMemoryExecutionStateOptions["commit"];
	#ownerFence: ExecutionStateSnapshot["ownerFence"];
	#undo: Map<string, ChangedEntity | null> | undefined;
	#persistenceFailure: { error: unknown } | undefined;
	#baseline = new Map<string, number>();

	constructor(options: InMemoryExecutionStateOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#commit = options.commit;
		if (options.snapshot !== undefined) this.#restore(options.snapshot);
		this.#baseline = this.#currentVersions();
	}

	#currentVersions(): Map<string, number> {
		const versions = new Map<string, number>();
		for (const record of this.#sessions.values()) versions.set(`session\0${record.id}`, record.version);
		for (const record of this.#tasks.values()) versions.set(`task\0${record.id}`, record.version);
		return versions;
	}

	bindOwner(sessionId: string, ownerId: string): void {
		this.#ownerFence = { sessionId, ownerId };
	}

	session(id: string): SessionRecord {
		return clone(this.#requireSession(id));
	}

	task(id: string): TaskRecord {
		return clone(this.#requireTask(id));
	}

	/** 某个 session 的全部子任务，按创建顺序。 */
	tasksOf(sessionId: string): TaskRecord[] {
		return [...this.#tasks.values()]
			.filter((task) => task.sessionId === sessionId)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.map(clone);
	}

	hasSession(id: string): boolean {
		return this.#sessions.has(id);
	}

	/** 只读导出；查看或保存失败不能提前推进持久化基线。 */
	exportSnapshot(): ExecutionStateSnapshot {
		return {
			schemaVersion: 2,
			...(this.#ownerFence === undefined ? {} : { ownerFence: { ...this.#ownerFence } }),
			sessions: [...this.#sessions.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id)),
			tasks: [...this.#tasks.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id)),
			commandReceipts: [...this.#receipts.values()]
				.map(clone)
				.sort((a, b) => a.commandId.localeCompare(b.commandId)),
		};
	}

	assertWritable(): void {
		if (this.#persistenceFailure !== undefined) throw this.#persistenceFailure.error;
	}

	createSession(input: CreateSessionInput): SessionRecord {
		return this.#execute(input.commandId, input, () => {
			const id = nonempty(input.id, "session.id");
			if (this.#sessions.has(id)) throw new ExecutionStateError("execution_conflict", `Session exists: ${id}`);
			const timestamp = this.#timestamp();
			const record: SessionRecord = {
				id,
				projectId: nonempty(input.projectId, "session.projectId"),
				kind: input.kind ?? "agent",
				status: "idle",
				...(input.model === undefined ? {} : { model: clone(input.model) }),
				turn: 0,
				...(input.baseRevisionId === undefined
					? {}
					: { baseRevisionId: nonempty(input.baseRevisionId, "session.baseRevisionId") }),
				createdAt: timestamp,
				updatedAt: timestamp,
				version: 1,
			};
			this.#remember("session", id);
			this.#sessions.set(id, record);
			return clone(record);
		});
	}

	/** idle → running：拿 lease、开新 turn；换模型只在这里发生。 */
	startTurn(input: StartTurnInput): SessionRecord {
		return this.#execute(input.commandId, input, () => {
			const session = this.#requireSession(input.sessionId);
			if (session.status === "running")
				throw new ExecutionStateError("session_running", `Session ${session.id} 已有 turn 在跑`);
			const timestamp = this.#timestamp();
			session.status = "running";
			session.turn += 1;
			session.lease = { ...input.lease };
			session.turnId = nonempty(input.turnId ?? input.lease.ownerId ?? "", "turn.id");
			if (input.model !== undefined) session.model = clone(input.model);
			delete session.lastFailure;
			touch(session, timestamp);
			return clone(session);
		});
	}

	/** running → idle。仍在跑的子任务标 interrupted；lease 释放。 */
	endTurn(input: EndTurnInput): SessionRecord {
		return this.#execute(input.commandId, input, () => {
			const session = this.#requireSession(input.sessionId);
			if (session.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Session ${session.id} 没有在跑的 turn`);
			const timestamp = this.#timestamp();
			for (const task of this.#tasks.values()) {
				if (task.sessionId !== session.id || task.status !== "running") continue;
				this.#remember("task", task.id);
				task.status = "interrupted";
				touch(task, timestamp);
			}
			session.status = "idle";
			delete session.lease;
			delete session.lastFailure;
			if (input.failure !== undefined) session.lastFailure = failure(input.failure);
			touch(session, timestamp);
			return clone(session);
		});
	}

	recordSessionCheckpoint(
		commandId: string,
		sessionId: string,
		checkpointRef: ExecutionResultReference,
		inboxSequence?: number,
	): SessionRecord {
		return this.#execute(
			commandId,
			{ commandId, sessionId, checkpointRef, inboxSequence: inboxSequence ?? null },
			() => {
				const session = this.#requireSession(sessionId);
				if (session.status !== "running")
					throw new ExecutionStateError("invalid_execution_transition", `Session ${session.id} 没有在跑的 turn`);
				session.checkpointRef = resultReference(checkpointRef);
				if (inboxSequence !== undefined)
					session.inboxSequence = nonnegative(inboxSequence, "session.inboxSequence");
				touch(session, this.#timestamp());
				return clone(session);
			},
		);
	}

	/** 阶段提交后推进 session 的已提交基线。 */
	advanceSessionRevision(commandId: string, sessionId: string, expected: string, next: string): SessionRecord {
		return this.#execute(commandId, { commandId, sessionId, expected, next }, () => {
			const session = this.#requireSession(sessionId);
			if (session.status !== "running" || session.baseRevisionId !== expected)
				throw new ExecutionStateError("revision_conflict", "session 的提交基线已变化");
			session.baseRevisionId = nonempty(next, "session.baseRevisionId");
			touch(session, this.#timestamp());
			return clone(session);
		});
	}

	/** 根 loop 的一次模型调用：只推进 session 的累计。 */
	recordSessionUsage(input: RecordUsageInput & { sessionId: string }): SessionRecord {
		return this.#execute(input.commandId, input, () => {
			const session = this.#requireSession(input.sessionId);
			if (session.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Session ${session.id} 没有在跑的 turn`);
			session.usage = addModelUsage(session.usage, usage(input.usage));
			touch(session, this.#timestamp());
			return clone(session);
		});
	}

	/** 脚本驱动的 session（rank）的结果。 */
	recordSessionResult(commandId: string, sessionId: string, result: ExecutionResultReference): SessionRecord {
		return this.#execute(commandId, { commandId, sessionId, result }, () => {
			const session = this.#requireSession(sessionId);
			session.result = resultReference(result);
			touch(session, this.#timestamp());
			return clone(session);
		});
	}

	/** 只删不在跑的 session；子任务与它一起走，执行对象留给回收。 */
	deleteSession(commandId: string, sessionId: string): void {
		this.#execute(commandId, { commandId, sessionId, operation: "delete" }, () => {
			const session = this.#requireSession(sessionId);
			if (session.status === "running")
				throw new ExecutionStateError("session_running", "turn 进行中不能删除 session；先 interrupt");
			for (const task of [...this.#tasks.values()]) {
				if (task.sessionId !== session.id) continue;
				this.#remember("task", task.id);
				this.#tasks.delete(task.id);
			}
			this.#sessions.delete(session.id);
			return { deleted: session.id };
		});
	}

	addTask(input: AddTaskInput): TaskRecord {
		return this.#execute(input.commandId, input, () => {
			const id = nonempty(input.id, "task.id");
			if (this.#tasks.has(id)) throw new ExecutionStateError("execution_conflict", `Task exists: ${id}`);
			const session = this.#requireSession(input.sessionId);
			if (session.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Session ${session.id} 没有在跑的 turn`);
			const key = nonempty(input.key, "task.key");
			for (const task of this.#tasks.values())
				if (task.sessionId === session.id && task.key === key)
					throw new ExecutionStateError("execution_conflict", `Task key already exists: ${key}`);
			if (input.parent?.taskId !== undefined) {
				const parent = this.#requireTask(input.parent.taskId);
				if (parent.sessionId !== session.id || parent.status !== "running")
					throw new ExecutionStateError("execution_conflict", "Parent Task must be active in the same session");
			}
			if (input.parent !== undefined) nonempty(input.parent.actionId, "task.parent.actionId");
			const timestamp = this.#timestamp();
			const task: TaskRecord = {
				id,
				sessionId: session.id,
				kind: nonempty(input.kind, "task.kind"),
				key,
				...(input.parent === undefined ? {} : { parent: { ...input.parent } }),
				...(input.title ? { title: input.title } : {}),
				status: "running",
				...(input.model === undefined ? {} : { model: clone(input.model) }),
				createdAt: timestamp,
				updatedAt: timestamp,
				version: 1,
			};
			this.#remember("task", id);
			this.#tasks.set(id, task);
			return clone(task);
		});
	}

	/** 被打断或失败的子任务接着跑：根 Agent 调 resume_task 时。 */
	resumeTask(commandId: string, taskId: string): TaskRecord {
		return this.#execute(commandId, { commandId, taskId, operation: "resume" }, () => {
			const task = this.#requireTask(taskId);
			const session = this.#requireSession(task.sessionId);
			if (session.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Session ${session.id} 没有在跑的 turn`);
			if (task.status !== "interrupted" && task.status !== "failed")
				throw new ExecutionStateError("invalid_execution_transition", `Task ${task.id} 不是可续跑状态`);
			task.status = "running";
			delete task.failure;
			touch(task, this.#timestamp());
			return clone(task);
		});
	}

	recordTaskCheckpoint(commandId: string, taskId: string, checkpointRef: ExecutionResultReference): TaskRecord {
		return this.#execute(commandId, { commandId, taskId, checkpointRef }, () => {
			const task = this.#requireTask(taskId);
			if (task.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Task is not running: ${task.id}`);
			task.checkpointRef = resultReference(checkpointRef);
			touch(task, this.#timestamp());
			return clone(task);
		});
	}

	/** 子任务的一次模型调用：Task 与 session 的累计同时推进。 */
	recordTaskUsage(input: RecordUsageInput & { taskId: string }): TaskRecord {
		return this.#execute(input.commandId, input, () => {
			const task = this.#requireTask(input.taskId);
			if (task.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Task is not running: ${task.id}`);
			const session = this.#requireSession(task.sessionId);
			const delta = usage(input.usage);
			const timestamp = this.#timestamp();
			task.usage = addModelUsage(task.usage, delta);
			session.usage = addModelUsage(session.usage, delta);
			touch(task, timestamp);
			touch(session, timestamp);
			return clone(task);
		});
	}

	completeTask(commandId: string, taskId: string, result: ExecutionResultReference): TaskRecord {
		return this.#execute(commandId, { commandId, taskId, result }, () => {
			const task = this.#requireTask(taskId);
			if (task.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Task cannot complete: ${task.id}`);
			task.status = "completed";
			task.result = resultReference(result);
			delete task.failure;
			touch(task, this.#timestamp());
			return clone(task);
		});
	}

	failTask(input: FailTaskInput): TaskRecord {
		return this.#execute(input.commandId, input, () => {
			const task = this.#requireTask(input.taskId);
			if (task.status !== "running")
				throw new ExecutionStateError("invalid_execution_transition", `Task cannot fail: ${task.id}`);
			task.status = "failed";
			task.failure = failure(input.failure);
			touch(task, this.#timestamp());
			return clone(task);
		});
	}

	/**
	 * 把没有活着的持有者的 running session 收敛回 idle，并记一句 process_restart；子任务标 interrupted。
	 * 停在半途的调用与动作不在这里管：下一个 turn 从 checkpoint 接着跑时补「被打断」的结果（Harness 设计第 5 节）。
	 * holderAlive 缺省视所有持有者为已死；LocalProjectService.open 传入 pid 存活判断，避免误判别的进程正在跑的。
	 * 2026-10-06 之前还有 paused 状态，那时落盘的 paused session 在这里一并收敛成 idle，原因转记为 lastFailure。
	 */
	recoverUnfinished(
		commandId: string,
		options: { holderAlive?(lease: SessionLease): boolean } = {},
	): ExecutionRecoveryResult {
		return this.#execute(commandId, { commandId, operation: "recover_unfinished" }, () => {
			const timestamp = this.#timestamp();
			const recoveredSessionIds: string[] = [];
			for (const candidate of [...this.#sessions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
				const session = this.#requireSession(candidate.id);
				const legacy = session as Omit<SessionRecord, "status"> & { status: string; pause?: ExecutionFailure };
				if (legacy.status === "paused") {
					session.status = "idle";
					delete session.lease;
					if (legacy.pause !== undefined) session.lastFailure = legacy.pause;
					delete legacy.pause;
					touch(session, timestamp);
					recoveredSessionIds.push(session.id);
					continue;
				}
				if (session.status !== "running") continue;
				if (session.lease !== undefined && options.holderAlive?.(session.lease) === true) continue;
				for (const task of this.#tasks.values()) {
					if (task.sessionId !== session.id || task.status !== "running") continue;
					this.#remember("task", task.id);
					task.status = "interrupted";
					touch(task, timestamp);
				}
				session.status = "idle";
				delete session.lease;
				session.lastFailure = {
					code: "process_restart",
					message: "上一次运行的进程没有正常结束；进度已保存，发一条消息即可继续",
					retryable: true,
				};
				touch(session, timestamp);
				recoveredSessionIds.push(session.id);
			}
			return { recoveredSessionIds };
		});
	}

	#execute<T>(commandIdValue: string, payload: unknown, operation: () => T): T {
		this.assertWritable();
		if (this.#undo !== undefined) {
			throw new ExecutionStateError("execution_conflict", "Execution commands cannot be reentrant");
		}
		const commandId = nonempty(commandIdValue, "commandId");
		const fingerprint = commandFingerprint(payload);
		const existing = this.#receipts.get(commandId);
		if (existing !== undefined) {
			if (existing.fingerprint !== fingerprint) {
				throw new ExecutionStateError(
					"duplicate_command_conflict",
					`Command ${commandId} was already used with different input`,
				);
			}
			return clone(existing.result) as T;
		}
		this.#undo = new Map();
		try {
			const result = operation();
			const receipt = { commandId, fingerprint, result: clone(result) };
			this.#receipts.set(commandId, receipt);
			if (this.#commit !== undefined) this.#commitDelta(this.#commit, receipt);
			return clone(result);
		} catch (error) {
			this.#rollback();
			this.#receipts.delete(commandId);
			throw error;
		} finally {
			this.#undo = undefined;
		}
	}

	/** 写集合取自 `#undo`：每处修改都先 `#remember`，回滚靠的也是它，所以它就是这条命令碰过的全部实体。 */
	#commitDelta(commit: (delta: ExecutionStateDelta) => void, receipt: ExecutionCommandReceipt): void {
		const changed: ExecutionStateDelta["changed"] = [];
		const deletedSessionIds: string[] = [];
		const touched: string[] = [];
		for (const key of this.#undo?.keys() ?? []) {
			const separator = key.indexOf("\0");
			const type = key.slice(0, separator) as ExecutionEntityType;
			const id = key.slice(separator + 1);
			const baselineVersion = this.#baseline.get(key);
			const record = this.#entityMap(type).get(id);
			if (record === undefined) {
				// 子任务随它的 session 一起删；新建又在同一命令里删掉的实体从没落库。
				if (type === "session" && baselineVersion !== undefined) deletedSessionIds.push(id);
				if (baselineVersion !== undefined) touched.push(key);
				continue;
			}
			// 只读过的实体不进写集合；另一个 session 的推进不能阻塞这次独立修改。
			if (record.version === baselineVersion) continue;
			changed.push({ type, record: clone(record), ...(baselineVersion === undefined ? {} : { baselineVersion }) });
			touched.push(key);
		}
		try {
			commit({
				...(this.#ownerFence === undefined ? {} : { ownerFence: { ...this.#ownerFence } }),
				changed,
				deletedSessionIds,
				receipt: clone(receipt),
			});
		} catch (error) {
			// 数据库可能已提交但返回失败。此实例不能猜测结果并继续，须重新读取持久状态。
			this.#persistenceFailure = { error };
			throw error;
		}
		for (const key of touched) {
			const separator = key.indexOf("\0");
			const record = this.#entityMap(key.slice(0, separator) as ExecutionEntityType).get(key.slice(separator + 1));
			if (record === undefined) this.#baseline.delete(key);
			else this.#baseline.set(key, record.version);
		}
	}

	#remember(type: ExecutionEntityType, id: string): void {
		if (this.#undo === undefined) return;
		const key = `${type}\0${id}`;
		if (this.#undo.has(key)) return;
		const record = this.#entityMap(type).get(id);
		this.#undo.set(key, record === undefined ? null : { type, snapshot: clone(record) });
	}

	#entityMap(type: ExecutionEntityType): Map<string, ExecutionEntitySnapshot> {
		return type === "session" ? this.#sessions : this.#tasks;
	}

	#rollback(): void {
		for (const [key, before] of this.#undo ?? []) {
			const separator = key.indexOf("\0");
			const type = key.slice(0, separator) as ExecutionEntityType;
			const id = key.slice(separator + 1);
			if (before === null) this.#entityMap(type).delete(id);
			else this.#entityMap(type).set(id, before.snapshot);
		}
	}

	#timestamp(): string {
		return this.#now().toISOString();
	}

	#requireSession(id: string): SessionRecord {
		this.#remember("session", id);
		const value = this.#sessions.get(id);
		if (value === undefined) throw new ExecutionStateError("execution_not_found", `Session not found: ${id}`);
		return value;
	}

	#requireTask(id: string): TaskRecord {
		this.#remember("task", id);
		const value = this.#tasks.get(id);
		if (value === undefined) throw new ExecutionStateError("execution_not_found", `Task not found: ${id}`);
		return value;
	}

	#restore(snapshot: ExecutionStateSnapshot): void {
		if (snapshot.schemaVersion !== 2) {
			throw new ExecutionStateError(
				"invalid_execution_snapshot",
				`Unsupported snapshot version: ${snapshot.schemaVersion}`,
			);
		}
		for (const session of snapshot.sessions) this.#insert(this.#sessions, session, "Session");
		for (const task of snapshot.tasks) this.#insert(this.#tasks, task, "Task");
		for (const receipt of snapshot.commandReceipts)
			this.#insert(this.#receipts, receipt, "Command receipt", "commandId");
		for (const task of this.#tasks.values()) {
			if (!this.#sessions.has(task.sessionId))
				throw new ExecutionStateError("invalid_execution_snapshot", `Task without session: ${task.id}`);
		}
	}

	#insert<T extends { id?: string; commandId?: string }>(
		map: Map<string, T>,
		value: T,
		label: string,
		key: "id" | "commandId" = "id",
	): void {
		const id = value[key];
		if (id === undefined || map.has(id)) {
			throw new ExecutionStateError("invalid_execution_snapshot", `${label} id is missing or duplicated`);
		}
		map.set(id, clone(value));
	}
}
