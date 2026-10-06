import type { ModelBindingSnapshot } from "../model/model-gateway.js";

/**
 * 执行模型只有两种实体（[Harness 设计](../../../../docs/harness-design.md)第 2 节）：
 *
 * - Session：一个根 Agent。一份连续的消息列表（checkpoint 对象）、当前模型绑定、累计用量、lease；
 *   作者第一条消息时创建，作者删除才结束。turn 不是实体——AG-UI 的 runId 就是 turn id。
 * - Task：一个子智能体（delegate / review / rank round）。有自己的消息列表与 checkpoint，完成后只读。
 *
 * 曾经的 Conversation / Run / Attempt 都没有了：Run 是 turn 的七态状态机，Attempt 是「冻结绑定」的载体，
 * 两者的信息现在分别是 turn 边界的事件与每条 AssistantMessage 自带的 provider / model。
 */
export type SessionStatus = "idle" | "running" | "paused";
export type SessionKind = "agent" | "rank";
export type TaskStatus = "running" | "completed" | "failed" | "interrupted";

/** 执行对象的引用；结果、checkpoint 都是 content-addressed 的执行对象。 */
export interface ExecutionResultReference {
	kind: "object";
	id: string;
}

export interface ExecutionFailure {
	code: string;
	message: string;
	retryable: boolean;
}

/** 一次或多次模型调用的累计用量；金额来自 pi-ai 按模型目录价格算出的 usage.cost，Suiming 不自建价格表。 */
export interface ModelUsage {
	calls: number;
	/** provider 已返回 usage 的调用数；缺省表示历史记录全部已确认。 */
	confirmedCalls?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** output 的子集；provider 不报告时为 0。 */
	reasoning: number;
	totalTokens: number;
	costUsd: number;
}

/**
 * 持有进行中 session 的进程。Local 的 lease 只是"哪个进程在跑"：同一台机器上进程还活着，别的进程打开 Project 时
 * 就不能把它当成崩溃遗留去恢复。
 */
export interface SessionLease {
	/** 每次取得执行权生成；PID 仅用于存活探测，不能作为写入凭证。 */
	ownerId?: string;
	pid: number;
	hostname: string;
	acquiredAt: string;
}

export interface SessionRecord {
	id: string;
	projectId: string;
	kind: SessionKind;
	status: SessionStatus;
	/** 根 Agent 当前的模型绑定；换模型在 turn 边界改它。 */
	model?: ModelBindingSnapshot;
	/** 已开始的 turn 数；`turnId` 是当前（或最近一个）turn 的 AG-UI runId。 */
	turn: number;
	turnId?: string;
	/** 全部 turn 与子任务的累计用量，每次模型调用后更新。 */
	usage?: ModelUsage;
	/** 根 loop 的 checkpoint 对象；进程重启从它续。 */
	checkpointRef?: ExecutionResultReference;
	/** 根 loop 已取走的 inbox 序号；大于它的消息还没进消息列表。 */
	inboxSequence?: number;
	/** session 已知的已提交基线：创建时是 head，作者在两个 turn 之间提交过、或本 session 阶段提交后推进。 */
	baseRevisionId?: string;
	/** running / paused 期间持有它的进程；结束后清空。 */
	lease?: SessionLease;
	/** paused 时要作者处理的原因；idle 时不存在。 */
	pause?: ExecutionFailure;
	/** 最近一个 turn 非正常结束的原因（作者一句话就能续的那类）；下一个 turn 开始时清掉。 */
	lastFailure?: ExecutionFailure;
	/** rank 之类脚本驱动的 session 的结果。 */
	result?: ExecutionResultReference;
	createdAt: string;
	updatedAt: string;
	version: number;
}

export interface TaskRecord {
	id: string;
	sessionId: string;
	kind: string;
	/** 父动作 id（或脚本给的稳定 key）；恢复按它找到已完成的子任务，不靠 JavaScript 栈。 */
	key: string;
	/** 发起委派的动作；taskId 缺省表示父是 session 的根 Agent。 */
	parent?: { taskId?: string; actionId: string };
	/** 给作者看的一句话：对话里子任务那一行显示它。2026-10-06 之前的记录没有，界面退回角色名。 */
	title?: string;
	status: TaskStatus;
	/** 子任务创建时冻结的模型绑定，跑完为止。 */
	model?: ModelBindingSnapshot;
	checkpointRef?: ExecutionResultReference;
	usage?: ModelUsage;
	result?: ExecutionResultReference;
	failure?: ExecutionFailure;
	createdAt: string;
	updatedAt: string;
	version: number;
}

export interface ExecutionCommandReceipt {
	commandId: string;
	fingerprint: string;
	result: unknown;
}

export interface ExecutionStateSnapshot {
	schemaVersion: 2;
	/** 写事务的持有权前置条件，不是额外持久状态。 */
	ownerFence?: { sessionId: string; ownerId: string };
	sessions: SessionRecord[];
	tasks: TaskRecord[];
	commandReceipts: ExecutionCommandReceipt[];
}

export type ExecutionEntityType = "session" | "task";
export type ExecutionEntitySnapshot = SessionRecord | TaskRecord;

/** 只读查询用的执行状态：session 与 task，不带命令回执。回执随项目历史无界增长，只有执行命令要它。 */
export type ExecutionEntities = Pick<ExecutionStateSnapshot, "sessions" | "tasks">;

/**
 * 一条执行命令的持久写集合：它改动的实体与它自己的回执。每条命令只写这几行，不整份重写执行状态——
 * 整份重写的成本随项目历史平方增长（2026-10-01 Harness 审查 F1）。
 */
export interface ExecutionStateDelta {
	ownerFence?: { sessionId: string; ownerId: string };
	/** 改动后的实体；`baselineVersion` 是它所基于的已持久版本，新建的实体没有。 */
	changed: { type: ExecutionEntityType; record: ExecutionEntitySnapshot; baselineVersion?: number }[];
	/** 被删掉的 session，连同它的子任务、inbox 与事件一起删。 */
	deletedSessionIds: string[];
	receipt: ExecutionCommandReceipt;
}

export interface ExecutionStateEvent {
	sequence: number;
	type: "execution.entity.changed";
	entityType: ExecutionEntityType;
	entityId: string;
	snapshot: ExecutionEntitySnapshot;
}

export interface ExecutionRecoveryResult {
	/** 持有进程已死、被收敛回 idle 的 session。 */
	recoveredSessionIds: string[];
}
