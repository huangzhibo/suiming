import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ToolCall } from "@earendil-works/pi-ai";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import {
	EventType,
	type ModelChoice,
	retryableErrorCode,
	type SuimingTurnSummary,
	USAGE_CHECKPOINT_TOKENS,
} from "@suiming/sdk";
import { candidateFromStoryFiles, changeOperationsBetween } from "../artifact/change-operations.js";
import { ArtifactError } from "../artifact/errors.js";
import { readOpenStoryDirectory, unrecognizedPaths } from "../artifact/open-story-directory.js";
import { validateStoryProjectCandidate } from "../artifact/story-design-validator.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import type { ArtifactCandidate, ArtifactIdentity, ProjectRevision } from "../artifact/types.js";
import { executionJsonBytes, parseExecutionJson } from "../execution/execution-object-codec.js";
import type { InMemoryExecutionState } from "../execution/in-memory-execution-state.js";
import { emptyModelUsage } from "../execution/model-usage.js";
import type {
	ExecutionFailure,
	ExecutionResultReference,
	ModelUsage,
	SessionKind,
	SessionLease,
	SessionRecord,
	TaskRecord,
} from "../execution/types.js";
import type { ModelProfileId } from "../model/config.js";
import { ModelGatewayError } from "../model/errors.js";
import type { BoundModelProfile, ModelBindingSnapshot, ModelGateway } from "../model/model-gateway.js";
import { CheckpointArchive } from "./checkpoint-archive.js";
import { type ConfinedEnvPolicy, ConfinedExecutionEnv } from "./confined-env.js";
import { SuimingHarnessError } from "./errors.js";
import { type SessionEvent, type SessionEventListener, SessionEventStream } from "./events.js";
import { type LoopCheckpoint, runTaskLoop, TASK_OPENING_AT, type TaskLoopOutcome } from "./loop.js";
import type { HarnessProjectPort } from "./project-port.js";
import { readProjectStatus } from "./project-status.js";
import type { HarnessTool } from "./tool.js";
import type { CandidateScanner } from "./tools.js";
import { textWrittenWithoutContext, turnSummary } from "./turn-summary.js";

export interface SuimingHarnessOptions {
	project: HarnessProjectPort;
	models: ModelGateway;
	/** turn / Task span 的根；模型调用 span 挂在它们下面。缺省 NOOP。 */
	telemetryContext?: TelemetryContext;
	now?: () => Date;
	/**
	 * 每轮用量检查点（折算 token，见 weightedUsage）；缺省 TURN_USAGE_CHECKPOINT_TOKENS。给函数时每个 turn 开始读一次，
	 * 桌面与 CLI 传的是读 config.toml 的函数，设置页改了下一轮就生效。
	 */
	turnUsageCheckpointTokens?: number | (() => number | Promise<number>);
}

/**
 * 每轮用量检查点：一个 turn 里根 Agent 与它的全部子任务的折算用量合计到这里，下一次请求之前停下，回 idle 并说明
 * 用了多少，作者说一句「继续」就从原处接着跑（子任务从自己的 checkpoint 续）。不是预算：不砍掉任何产出，也不替
 * 作者判断值不值，只保证没人看着时一轮最多用掉这么多。
 * 2026-10-04 抽三国时 5 个补全子任务在压缩里空转 19 分钟、估算 $92，没有任何东西停住它们；那个循环修掉了，但循环
 * 长什么样事先列不全，兜底必须与循环的形状无关。
 * 不按美元算：同样的工作量在 DeepSeek Flash 上约是 GPT-6.1 Sol 的十分之一、在 Claude Opus 上约是两倍，一个美元数
 * 对便宜模型等于放任空转、对贵模型又频繁打断正常工作；一轮里根、writer、reviewer 也可能是不同的模型。也不按原始
 * token 总数算：空转 4,844 万、斗破整本抽取 3,949 万，分不开——空转几乎全是未缓存请求，正常的长任务大多命中缓存。
 * 600 万的依据：折算后空转 4,620 万，最重的正常单轮（斗破整本抽取）880 万撞线一次，三国分段加整合 485 万一轮做完；
 * 在 GPT-6.1 Sol 上约 $12，DeepSeek Flash 约 $1.7，Claude Opus 约 $24。
 */
export const TURN_USAGE_CHECKPOINT_TOKENS: number = USAGE_CHECKPOINT_TOKENS.default;

/** 折算用量：未缓存输入与缓存写按一，缓存读按一成，输出按五倍——主流模型目录价的大致比例，不随单价变。 */
export function weightedUsage(usage: Pick<ModelUsage, "input" | "cacheRead" | "cacheWrite" | "output">): number {
	return usage.input + usage.cacheWrite + usage.cacheRead * 0.1 + usage.output * 5;
}

function usageAttributes(prefix: string, usage: ModelUsage): Record<string, number> {
	return {
		[`${prefix}.model_calls`]: usage.calls,
		[`${prefix}.input_tokens`]: usage.input,
		[`${prefix}.output_tokens`]: usage.output,
		[`${prefix}.total_tokens`]: usage.totalTokens,
		[`${prefix}.cost_usd`]: usage.costUsd,
	};
}

/** 一个 loop（根 Agent 或子任务）拿到的运行时句柄：受限环境与候选扫描器。 */
export interface TaskHandle {
	telemetryContext?: TelemetryContext;
	/** 根 Agent 的 handle 上是 sessionId。 */
	taskId: string;
	env: ConfinedExecutionEnv;
	scan: CandidateScanner;
}

/** 子智能体的规格。 */
export interface TaskSpec {
	/** 同一契约的稳定身份：委派用父动作 id，脚本（rank）用自己的 key。恢复按它找已完成的子任务。 */
	key: string;
	parent?: { taskId?: string; actionId: string };
	/**
	 * 子任务的角色，也就是它绑定的模型档位（writer、reviewer、source-extractor、judge……），记成 TaskRecord 的 kind、
	 * AG-UI SUBAGENT_STARTED 的 name。2026-10-05 之前另有一维 kind（subagent / review / rank.round），按建它的入口起名，
	 * 其中 subagent 说的是类别本身；角色能推出入口，入口推不出角色，所以只留角色。
	 */
	profileId: ModelProfileId;
	/** 给作者看的一句话（对话里子任务那一行显示它），不进模型的请求。 */
	title?: string;
	policy: ConfinedEnvPolicy;
	writable?: (logicalPath: string) => boolean;
	readable?: (logicalPath: string) => boolean;
	systemPrompt: string;
	prompt: string;
	maxTurns: number;
	tools(handle: TaskHandle): HarnessTool[];
	/** 内循环终止后要持久化的结果；返回 undefined 表示没有提交。 */
	result(): unknown;
	resultMediaType: string;
}

export interface TaskOutcome {
	taskId: string;
	resultObjectId: string;
	loop: TaskLoopOutcome;
	/** spec.result() 提交的值；续跑复用已完成的 Task 时从执行对象读回，调用方只能依赖它，不能依赖工具闭包。 */
	result: unknown;
}

/** 根 Agent 一个 turn 的规格。没有交付协议：模型一次响应里没有工具调用，turn 就结束。 */
export interface RootLoopSpec {
	systemPrompt: string;
	/** 只在 session 第一次跑时进消息列表的开场（作品 Frame 等）。 */
	prompt?: string;
	tools(handle: TaskHandle): HarnessTool[];
	/** 作者消息进消息列表前附的确定性状态行（head、候选状态）；在取走消息的那一刻算。 */
	decorateInbox?(text: string, sequence: number): string | Promise<string>;
}

export interface RootLoopOutcome {
	stop: TaskLoopOutcome["stop"];
	/** 本 turn 里 Agent 最后一条完整回复。 */
	reply: string;
	turns: number;
}

interface HarnessCheckpoint {
	schemaVersion: 2;
	loop: LoopCheckpoint;
}

interface TaskResultObject {
	schemaVersion: 4;
	taskKind: string;
	turns: number;
	usage: ModelUsage;
	result: unknown;
}

export function executionFailure(error: unknown, fallbackCode = "turn_failed"): ExecutionFailure {
	const coded =
		error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
			? (error as Error & { code: string })
			: undefined;
	const code = coded?.code ?? fallbackCode;
	return {
		code,
		message: error instanceof Error ? error.message : "Unknown failure",
		retryable: retryableErrorCode(code),
	};
}

function reasonText(signal: AbortSignal | undefined, fallback: string): string {
	const reason = signal?.reason;
	return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : fallback;
}

export interface TurnOptions {
	signal?: AbortSignal;
	onEvent?: SessionEventListener;
	/** 从这个 turn 起换用的模型。 */
	model?: ModelBindingSnapshot;
	onStarted?(value: { sessionId: string; turnId: string }): Promise<void> | void;
}

export interface TurnOutcome<T> {
	session: SessionRecord;
	/** body 正常返回的值；turn 被打断或失败时没有。 */
	value?: T;
	failure?: ExecutionFailure;
}

/**
 * 一个 session 在本进程内的一次 turn 的把手：执行状态、作者的 checkout、事件流与中断边界。
 * 它不是持久实体——Session / Task 在 `execution/` 里，这里只是一次进程内驱动。
 *
 * Agent 直接在 checkout 上工作（没有 per-session worktree）：作者、host agent 与 Agent 只有一份候选、
 * 一份 diff、一条提交路径。要并行跑多个 session 时再给 session 配可选工作目录，接口位置就是 `checkoutPath`。
 */
export class HarnessSession {
	readonly sessionId: string;
	/** 模型的文件工具与扫描都在这个目录里；`.git` / `.suiming` 与 host 接入目录由 `ConfinedExecutionEnv` 挡住。 */
	readonly checkoutPath: string;
	/** 上一个 turn 之后作品有没有新提交（作者或 host agent 提交过）。turn 开场的系统附注用它。 */
	readonly headMoved: boolean;
	readonly events: SessionEventStream;
	readonly #engine: SuimingHarness;
	readonly #execution: InMemoryExecutionState;
	readonly #signal: AbortSignal | undefined;
	/** 已提交基线：当前 head 的快照。turn 开场 Context 与「未提交了几个文件」都相对它算。 */
	#base: ArtifactCandidate;
	#telemetry: TelemetryContext;
	#lastReply = "";
	#revisions = 0;
	/** 本 turn 里根与全部子任务已确认的折算用量与估算花费；用量检查点看前者，停下时两样都报。 */
	#usageTokens = 0;
	#spentUsd = 0;
	readonly #usageCheckpoint: number;
	constructor(
		engine: SuimingHarness,
		input: {
			sessionId: string;
			base: ArtifactCandidate;
			headMoved: boolean;
			execution: InMemoryExecutionState;
			events: SessionEventStream;
			signal: AbortSignal | undefined;
			telemetry: TelemetryContext;
			usageCheckpoint: number;
		},
	) {
		this.#engine = engine;
		this.#usageCheckpoint = input.usageCheckpoint;
		this.sessionId = input.sessionId;
		this.checkoutPath = engine.project.paths.checkoutPath;
		this.#base = input.base;
		this.headMoved = input.headMoved;
		this.#execution = input.execution;
		this.events = input.events;
		this.#signal = input.signal;
		this.#telemetry = input.telemetry;
	}

	/** 工具要查作品状态、读执行对象时用的端口。 */
	get projectPort(): HarnessProjectPort {
		return this.#engine.project;
	}

	get execution(): InMemoryExecutionState {
		return this.#execution;
	}

	/** 一个角色当前绑定模型的上下文窗口（token）；拿不到时 undefined。Source 分段按它定大小。 */
	async contextWindow(profileId: ModelProfileId): Promise<number | undefined> {
		try {
			return (await this.#bindForTask(profileId)).model.contextWindow || undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 新子任务的模型：配置里没单独设的角色跟随这次对话的绑定（根 Agent 的模型与参数，换上自己的 profile 名），
	 * 单独配置过的按配置绑。2026-10-05 之前一律按配置绑，没设的回落到设置页的默认模型。
	 */
	async #bindForTask(profileId: ModelProfileId): Promise<BoundModelProfile> {
		const conversation = this.record.model;
		if (conversation !== undefined && this.#engine.followsConversation(profileId))
			return this.#engine.bindModel(profileId, { ...conversation, modelProfileId: profileId });
		return this.#engine.bindModel(profileId);
	}

	get record(): SessionRecord {
		return this.#execution.session(this.sessionId);
	}

	/** 已提交基线，即 turn 开始时的 head、或最近一次阶段提交之后的版本。 */
	get currentRevisionId(): string {
		return this.#base.baseRevisionId;
	}

	/** 已提交基线的快照。它是权威作品，不含 checkout 里尚未提交的修改。 */
	get base(): ArtifactCandidate {
		return this.#base;
	}

	/** 扫描 checkout 得到当前候选。非规范路径、重复 identity 在这里抛 ArtifactError。 */
	async scan(): Promise<ArtifactCandidate> {
		return (await this.scanAll()).candidate;
	}

	/** 候选加上被忽略的非作品文件（`scripts/` 之类）：提交结果要点名它们不进版本。 */
	async scanAll(): Promise<{ candidate: ArtifactCandidate; ignored: string[] }> {
		const scanned = await readOpenStoryDirectory(this.checkoutPath);
		return {
			candidate: candidateFromStoryFiles(this.currentRevisionId, scanned.files, unrecognizedPaths(scanned.ignored)),
			ignored: scanned.ignored.filter((entry) => entry.kind === "repository-auxiliary").map((entry) => entry.path),
		};
	}

	/** 本 turn 里 Agent 的提交推进了几个版本；turn 结束的对账用它。 */
	get revisionsThisTurn(): number {
		return this.#revisions;
	}

	throwIfInterrupted(): void {
		this.#execution.assertWritable();
		this.events.assertWritable();
		if (this.#signal?.aborted === true)
			throw new SuimingHarnessError("run_interrupted", reasonText(this.#signal, "turn 已被作者打断"));
	}

	/** 每次模型请求之前：本 turn 的折算用量到了检查点就不再发。在途的请求照常收完，超出的只有它们。 */
	#throwIfUsageCheckpoint(): void {
		const limit = this.#usageCheckpoint;
		if (this.#usageTokens < limit) return;
		const tenThousands = (tokens: number) => Math.round(tokens / 10_000);
		const spent = this.#spentUsd > 0 ? `，按模型目录价估算 $${this.#spentUsd.toFixed(2)}` : "";
		throw new SuimingHarnessError(
			"turn_usage_checkpoint",
			`这一轮的用量折合 ${tenThousands(this.#usageTokens)} 万 token${spent}，到了每轮 ${tenThousands(limit)} 万的用量检查点，先停在这里。进度都保留着，说一句「继续」就从原处接着做。`,
		);
	}

	/** inbox 里还没进消息列表的作者消息。 */
	pendingInbox(): { sequence: number; text: string }[] {
		const consumed = this.record.inboxSequence ?? 0;
		return this.#engine.project.readInbox(this.sessionId).filter((item) => item.sequence > consumed);
	}

	/** 根 Agent 的一个 turn：从 session 的 checkpoint 续，模型停下即返回。 */
	async runRoot(spec: RootLoopSpec): Promise<RootLoopOutcome> {
		this.throwIfInterrupted();
		const record = this.record;
		if (!record.model) throw new SuimingHarnessError("model_binding_missing", "session 没有模型绑定");
		const model = await this.#engine.bindModel("main", record.model);
		// 根 Agent 的写范围是整个 checkout（.git / .suiming 与 host 接入目录除外，由 ConfinedExecutionEnv 拦），
		// 合法性在 commit 时由 Checker 判；只有子任务按角色缩小写范围（Harness 设计第 6 节）。
		const env = new ConfinedExecutionEnv({ rootPath: this.checkoutPath, policy: "write" });
		const restored = await this.#restore(record.checkpointRef);
		// 模型已经停下、inbox 也没有新消息：不该开新的模型调用。
		if (restored !== undefined && restored.loop.phase === "settled" && this.pendingInbox().length === 0)
			return { stop: restored.loop.stop ?? "model_stopped", reply: "", turns: restored.loop.turns };
		const outcome = await this.#drive({
			loopId: this.sessionId,
			model,
			env,
			restored,
			systemPrompt: spec.systemPrompt,
			...(restored === undefined && spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
			maxTurns: Number.MAX_SAFE_INTEGER,
			tools: spec.tools,
			telemetry: this.#telemetry,
			steering: true,
			...(spec.decorateInbox === undefined ? {} : { decorateInbox: spec.decorateInbox }),
			saveCheckpoint: async (checkpoint, loop) => {
				const object = await this.#engine.checkpoints.write(checkpoint);
				this.#execution.recordSessionCheckpoint(
					`${this.sessionId}:loop:${loop.sequence}`,
					this.sessionId,
					{ kind: "object", id: object.id },
					loop.steeringSequence,
				);
			},
			recordRequest: (callId) =>
				this.#execution.recordSessionUsage({
					commandId: `${this.sessionId}:request:${callId}`,
					sessionId: this.sessionId,
					usage: { ...emptyModelUsage(), calls: 1, confirmedCalls: 0 },
				}),
			recordUsage: (callId, usage) =>
				this.#execution.recordSessionUsage({
					commandId: `${this.sessionId}:usage:${callId}`,
					sessionId: this.sessionId,
					usage: { ...usage, calls: 0, confirmedCalls: 1 },
				}),
		});
		return { stop: outcome.loop.stop, reply: this.#lastReply, turns: outcome.loop.turns };
	}

	async executeChild(
		parent: TaskHandle,
		actionId: string,
		spec: Omit<TaskSpec, "key" | "parent">,
	): Promise<TaskOutcome> {
		return this.executeTask(
			{
				...spec,
				key: actionId,
				parent: { ...(parent.taskId === this.sessionId ? {} : { taskId: parent.taskId }), actionId },
			},
			parent.telemetryContext,
		);
	}

	/** 子智能体：同一 key 已完成就直接读结果，interrupted / failed 的接着跑。 */
	async executeTask(spec: TaskSpec, telemetryContext: TelemetryContext = this.#telemetry): Promise<TaskOutcome> {
		this.throwIfInterrupted();
		const existing = this.#execution.tasksOf(this.sessionId).find((task) => task.key === spec.key);
		if (existing !== undefined) {
			// 10-05 之前的记录 kind 是 subagent / review / rank.round，角色在它的模型绑定里
			const role = existing.model?.modelProfileId ?? existing.kind;
			if (role !== spec.profileId || JSON.stringify(existing.parent) !== JSON.stringify(spec.parent))
				throw new SuimingHarnessError("task_contract_mismatch", `Task ${spec.key} 的契约不一致`);
			if (existing.status === "completed") return this.#engine.readTaskOutcome(existing);
		}
		const taskId = existing?.id ?? `task_${randomUUID()}`;
		return telemetryContext.startSpan(
			{
				name: `suiming.task ${spec.profileId}`,
				attributes: {
					"suiming.session.id": this.sessionId,
					"suiming.task.id": taskId,
					"suiming.task.kind": spec.profileId,
					"langfuse.observation.type": "agent",
					"suiming.model.profile_id": spec.profileId,
				},
			},
			async (span) => {
				const outcome = await this.#executeTask(spec, taskId, existing, span);
				span.setAttributes({
					...usageAttributes("suiming.task", this.#execution.task(taskId).usage ?? emptyModelUsage()),
					"suiming.task.turns": outcome.loop.turns,
				});
				return outcome;
			},
		);
	}

	async #executeTask(
		spec: TaskSpec,
		taskId: string,
		existing: TaskRecord | undefined,
		span: TelemetrySpan,
	): Promise<TaskOutcome> {
		let task: TaskRecord;
		let model: BoundModelProfile | undefined;
		if (existing === undefined) {
			const bound = await this.#bindForTask(spec.profileId);
			task = this.#execution.addTask({
				commandId: `${this.sessionId}:task:${taskId}:add`,
				id: taskId,
				sessionId: this.sessionId,
				kind: spec.profileId,
				key: spec.key,
				...(spec.parent === undefined ? {} : { parent: spec.parent }),
				...(spec.title === undefined ? {} : { title: spec.title }),
				model: bound.snapshot,
			});
		} else {
			if (!existing.model) throw new SuimingHarnessError("model_binding_missing", `Task ${taskId} 没有模型绑定`);
			// 续跑沿用当初冻结的模型。它用不了了（模型目录变了、凭据删了）就在改状态之前交回父模型，由它重新委派，
			// 不掀掉整轮——否则下一轮的「被打断」提示又叫它续，每轮都撞在同一处。
			try {
				model = await this.#engine.bindModel(spec.profileId, existing.model);
			} catch (error) {
				if (!(error instanceof ModelGatewayError)) throw error;
				throw new SuimingHarnessError(
					"task_model_unavailable",
					`它当初用的模型现在用不了（${error.message}），没法接着做；要做就重新委派`,
				);
			}
			task =
				existing.status === "running"
					? existing
					: this.#execution.resumeTask(`${this.sessionId}:task:${taskId}:resume:${existing.version}`, taskId);
		}
		this.throwIfInterrupted();
		if (!task.model) throw new SuimingHarnessError("model_binding_missing", `Task ${taskId} 没有模型绑定`);
		model ??= await this.#engine.bindModel(spec.profileId, task.model);
		const env = new ConfinedExecutionEnv({
			rootPath: this.checkoutPath,
			policy: spec.policy,
			...(spec.writable === undefined ? {} : { writable: spec.writable }),
			...(spec.readable === undefined ? {} : { readable: spec.readable }),
		});
		const restored = await this.#restore(task.checkpointRef);
		this.events.refresh();
		let outcome: { loop: TaskLoopOutcome };
		try {
			outcome = await this.#drive({
				loopId: taskId,
				model,
				env,
				restored,
				systemPrompt: spec.systemPrompt,
				...(restored === undefined ? { prompt: spec.prompt } : {}),
				openingLimit: TASK_OPENING_AT,
				maxTurns: spec.maxTurns,
				tools: spec.tools,
				telemetry: span,
				steering: false,
				captureSubmission: spec.result,
				saveCheckpoint: async (checkpoint, loop) => {
					const object = await this.#engine.checkpoints.write(checkpoint);
					this.#execution.recordTaskCheckpoint(`${taskId}:loop:${loop.sequence}`, taskId, {
						kind: "object",
						id: object.id,
					});
				},
				recordRequest: (callId) =>
					this.#execution.recordTaskUsage({
						commandId: `${taskId}:request:${callId}`,
						taskId,
						usage: { ...emptyModelUsage(), calls: 1, confirmedCalls: 0 },
					}),
				recordUsage: (callId, usage) =>
					this.#execution.recordTaskUsage({
						commandId: `${taskId}:usage:${callId}`,
						taskId,
						usage: { ...usage, calls: 0, confirmedCalls: 1 },
					}),
			});
		} catch (error) {
			// 打断、用量检查点与持久化故障留给 turn 收口（turn 结束时子任务标 interrupted，续跑接着来）；
			// 其余是这个子任务自己的失败，记在它身上，由父模型决定下一步。
			const code = executionFailure(error).code;
			if (code !== "run_interrupted" && code !== "turn_usage_checkpoint" && this.#writable()) {
				this.#execution.failTask({
					commandId: `${taskId}:fail:${this.#execution.task(taskId).version}`,
					taskId,
					failure: executionFailure(error),
				});
				this.events.refresh();
			}
			throw error;
		}
		const value = outcome.loop.submission ?? spec.result();
		if (outcome.loop.stop !== "terminated" || value === undefined) {
			const code = outcome.loop.stop === "budget_exhausted" ? "task_budget_exhausted" : "task_not_submitted";
			const message =
				outcome.loop.stop === "budget_exhausted"
					? `子任务已用完 ${spec.maxTurns} 次模型调用，尚未交付。`
					: `子任务的模型停下了，但没有交付结果；已保存 ${outcome.loop.turns} 次调用的进度。`;
			this.#execution.failTask({
				commandId: `${taskId}:fail:${this.#execution.task(taskId).version}`,
				taskId,
				failure: { code, message, retryable: true },
			});
			this.events.refresh();
			throw new SuimingHarnessError(code, message);
		}
		const record: TaskResultObject = {
			schemaVersion: 4,
			taskKind: spec.profileId,
			turns: outcome.loop.turns,
			usage: outcome.loop.usage,
			result: value,
		};
		const object = await this.#engine.project.saveExecutionObject(spec.resultMediaType, executionJsonBytes(record));
		this.#execution.completeTask(`${taskId}:complete`, taskId, { kind: "object", id: object.id });
		this.events.refresh();
		return { taskId, resultObjectId: object.id, loop: outcome.loop, result: value };
	}

	#writable(): boolean {
		try {
			this.#execution.assertWritable();
			return true;
		} catch {
			return false;
		}
	}

	async #restore(ref: ExecutionResultReference | undefined): Promise<HarnessCheckpoint | undefined> {
		if (ref === undefined) return undefined;
		const object = await this.#engine.project.readExecutionObject(ref.id);
		const restored = (await this.#engine.checkpoints.read(object.bytes)) as HarnessCheckpoint;
		if (restored.schemaVersion !== 2) throw new SuimingHarnessError("checkpoint_invalid", "checkpoint 版本不支持");
		return restored;
	}

	/** 根 Agent 与子任务共用的驱动：checkpoint、事件与用量记账都在这里。 */
	async #drive(input: {
		loopId: string;
		model: BoundModelProfile;
		env: ConfinedExecutionEnv;
		restored: HarnessCheckpoint | undefined;
		systemPrompt: string;
		prompt?: string;
		openingLimit?: number;
		maxTurns: number;
		tools(handle: TaskHandle): HarnessTool[];
		telemetry: TelemetryContext;
		steering: boolean;
		decorateInbox?(text: string, sequence: number): string | Promise<string>;
		captureSubmission?(): unknown;
		saveCheckpoint(checkpoint: HarnessCheckpoint, loop: LoopCheckpoint): Promise<void>;
		recordRequest(callId: string): void;
		recordUsage(callId: string, usage: ModelUsage): void;
	}): Promise<{ loop: TaskLoopOutcome }> {
		const { restored } = input;
		const scan: CandidateScanner = () => this.scan();
		const handle: TaskHandle = { telemetryContext: input.telemetry, taskId: input.loopId, env: input.env, scan };
		// 从 checkpoint 接着跑也用当前的工具面与 systemPrompt：半途的动作不重做，不需要冻结当时的声明。
		const tools = input.tools(handle);
		let loop = restored?.loop;
		// 未交付是可继续的协议暂停；显式续跑仍沿用原消息列表，而非返回旧 settled 结果。
		if (loop && loop.phase === "settled" && loop.stop !== "terminated") {
			loop = { ...loop, phase: "ready" };
			delete loop.stop;
			delete loop.unsubmittedStops;
		}
		// 增量事件上的 sessionId 与信封、threadId 有重复，刻意保留：`suim session send --events` 把事件流原样交给 host，
		// 仓库里没有消费者不等于没人用。子任务的事件带标准的 subagentRunId（就是 task id）；2026-10-05 之前用
		// metadata.suiming.taskId / taskKind 标，根 Agent 的 taskKind 是 "agent"。
		const metadata = { suiming: { sessionId: this.sessionId } };
		const subagentRunId = input.loopId === this.sessionId ? undefined : input.loopId;
		const outcome = await runTaskLoop({
			model: input.model,
			systemPrompt: input.systemPrompt,
			...(input.prompt === undefined ? {} : { prompt: input.prompt }),
			...(input.openingLimit === undefined ? {} : { openingLimit: input.openingLimit }),
			loopId: input.loopId,
			...(loop === undefined ? {} : { checkpoint: loop }),
			...(input.captureSubmission === undefined ? {} : { captureSubmission: input.captureSubmission }),
			saveCheckpoint: async (state) => {
				await input.saveCheckpoint({ schemaVersion: 2, loop: state }, state);
				// 请求一旦可能发出就记一次调用；按 commandId 幂等，重复保存不会重复计数。
				const latest = state.calls.at(-1);
				if (latest && latest.state !== "prepared") input.recordRequest(latest.id);
			},
			tools,
			budget: { maxTurns: input.maxTurns },
			...(this.#signal === undefined ? {} : { signal: this.#signal }),
			telemetryContext: input.telemetry,
			onTurnStart: () => {
				this.throwIfInterrupted();
				this.#throwIfUsageCheckpoint();
			},
			onModelCall: (usage, callId) => {
				input.recordUsage(callId, usage);
				this.#usageTokens += weightedUsage(usage);
				if (Number.isFinite(usage.costUsd)) this.#spentUsd += usage.costUsd;
			},
			...(input.steering
				? {
						steering: () => this.#engine.project.readInbox(this.sessionId),
						onSteer: (text: string, sequence: number) =>
							this.events.message(
								`${this.sessionId}:inbox:${sequence}`,
								text,
								true,
								{ suiming: { sessionId: this.sessionId, inboxSequence: sequence } },
								"user",
							),
						...(input.decorateInbox === undefined ? {} : { decorateSteering: input.decorateInbox }),
					}
				: {}),
			onTextDelta: (delta, callId) => this.events.appendText(callId, delta, metadata, subagentRunId),
			onMessage: (callId, message) => {
				const content = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
				const previous = this.events.durableEvent(`${callId}:start`);
				this.events.message(
					callId,
					content,
					true,
					previous?.event.metadata ?? metadata,
					"assistant",
					subagentRunId,
				);
				if (input.steering && content) this.#lastReply = content;
			},
			onToolCall: (event) => {
				// 已发布活动保持原样，恢复不会因 UI 投影升级改写历史。
				if (this.events.durableEvent(`${event.actionId}:result`) !== undefined) return;
				this.events.emit(
					{
						type: EventType.ACTIVITY_SNAPSHOT,
						messageId: event.actionId,
						activityType: "suiming.action",
						replace: true,
						...(subagentRunId === undefined ? {} : { subagentRunId }),
						content: {
							label: event.toolName,
							status: event.isError ? "failed" : "completed",
							summary: event.summary,
							...actionTarget(event.args),
							isError: event.isError,
						},
					},
					`${event.actionId}:result`,
				);
			},
		});
		return { loop: outcome };
	}

	/**
	 * 只扫描并验证候选，不写 Canon。返回的是摘要而不是整份候选字节：提交由 `commitCheckout` 重扫 checkout
	 * 完成（同一把项目锁内），checkpoint 里不必冻结几十万字的正文。
	 */
	async prepareStageCommit(telemetryContext: TelemetryContext = this.#telemetry): Promise<{
		baseRevisionId: string;
		/**
		 * 这次提交会进版本的文件。作者、host agent 与 Agent 改的是同一份候选，所以作者尚未提交的修改
		 * 也在这份清单里——模型据此在回复里点名，不让它静默进版本。空数组表示这次 commit 不产生新版本。
		 */
		changed: string[];
		/** 候选里不属于作品的文件（scripts/、out/ 之类），永远不进版本；提交结果里点名，免得模型以为存上了。 */
		ignored: string[];
	}> {
		const scanned = await this.scanAll();
		const candidate = scanned.candidate;
		const operations = changeOperationsBetween(this.#base, candidate);
		// 删除的 artifact 已不在候选里，路径要回基线投影（StoryBeat 的路径取决于它所属的卷）。
		const pathOf = (identity: ArtifactIdentity): string => {
			for (const source of [candidate, this.#base]) {
				try {
					return storyPackageCodec.pathForIdentity(identity, source);
				} catch {
					// 下一个来源
				}
			}
			return `${identity.kind}:${identity.localId}`;
		};
		await telemetryContext.startSpan(
			{
				name: "suiming.checker.commit",
				attributes: { "langfuse.observation.type": "guardrail", "suiming.change_count": operations.length },
			},
			async () => {
				validateStoryProjectCandidate(candidate);
			},
		);
		return {
			baseRevisionId: this.currentRevisionId,
			changed: operations.map((operation) => pathOf(operation.identity)).sort(),
			ignored: scanned.ignored,
		};
	}

	/**
	 * 阶段提交，成功后继续原 Agent。它就是作者「提交」按钮与 host `suim commit` 的同一条路：
	 * 扫 checkout diff → ChangeSet → Checker → 推进 canon ref，只多一个 commandId 回执，提交被打断时据此告诉模型
	 * 提交成了没有（committedRevision）。没有合并步骤——作者与 Agent 改同一文件时冲突在动作发生的当下就解决了
	 * （`edit` 的 `oldText`、保存的 `expectedSHA`）。
	 */
	async commitStage(actionId: string): Promise<{ created: boolean; revision: ProjectRevision }> {
		this.throwIfInterrupted();
		const commandId = `${this.sessionId}:commit:${actionId}`;
		const committed = await this.#engine.project.commitCheckout({ commandId });
		const revision = committed.revision;
		if (this.currentRevisionId !== revision.id) {
			this.#execution.advanceSessionRevision(
				`${commandId}:advance`,
				this.sessionId,
				this.currentRevisionId,
				revision.id,
			);
			this.#base = await this.#engine.project.historyReader().snapshot(revision.id);
			this.#revisions += 1;
		}
		this.events.refresh();
		return committed;
	}

	/** 这个 commit 动作有没有提交成：提交与回执是同一个 git 提交，查得到回执就是成了。 */
	committedRevision(actionId: string): Promise<ProjectRevision | undefined> {
		return this.#engine.project.committedRevision(`${this.sessionId}:commit:${actionId}`);
	}

	/** 建这个子任务的那次动作（委派、审稿）：从父 loop 已保存的 checkpoint 里读，续跑时沿用它的参数。 */
	async originalCall(task: TaskRecord): Promise<ToolCall | undefined> {
		const parent = task.parent?.taskId === undefined ? this.record : this.#execution.task(task.parent.taskId);
		const restored = await this.#restore(parent.checkpointRef);
		return restored?.loop.actions.find((action) => action.id === task.key)?.call;
	}
}

interface TurnStart {
	candidate: ArtifactCandidate;
	inboxSequence: number;
	/** turn 开始前最后一条事件的序号：对账只看这一轮的动作。 */
	eventSequence: number;
}

/** turn 开始时的 checkout 与收件箱位置；读不出 checkout 时不做对账，这一轮自己会报出原因。 */
async function turnStart(session: HarnessSession): Promise<TurnStart | undefined> {
	try {
		return {
			candidate: await session.scan(),
			inboxSequence: session.record.inboxSequence ?? 0,
			eventSequence: session.events.lastSequence(),
		};
	} catch {
		return undefined;
	}
}

/**
 * 单一 SuimingHarness：根 Agent 与子智能体共用 Session / Task 持久化、checkout、受限工具、
 * 自有内循环与 AG-UI 事件。turn 是它唯一的驱动单位。
 */
export class SuimingHarness {
	readonly project: HarnessProjectPort;
	readonly checkpoints: CheckpointArchive;
	readonly telemetry: TelemetryContext;
	readonly #models: ModelGateway;
	readonly now: () => Date;
	readonly #usageCheckpoint: () => number | Promise<number>;

	constructor(options: SuimingHarnessOptions) {
		this.project = options.project;
		this.checkpoints = new CheckpointArchive(options.project);
		this.telemetry = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
		this.#models = options.models;
		this.now = options.now ?? (() => new Date());
		const checkpoint = options.turnUsageCheckpointTokens ?? TURN_USAGE_CHECKPOINT_TOKENS;
		this.#usageCheckpoint = typeof checkpoint === "number" ? () => checkpoint : checkpoint;
	}

	bindModel(profileId: ModelProfileId, snapshot?: ModelBindingSnapshot): Promise<BoundModelProfile> {
		return snapshot ? this.#models.bindFrozen(snapshot) : this.#models.bind(profileId);
	}

	followsConversation(profileId: ModelProfileId): boolean {
		return this.#models.followsConversation(profileId);
	}

	/** 本进程对 session 的持有声明；别的进程打开 Project 时据此判断它不是崩溃遗留。 */
	#lease(): SessionLease {
		return { ownerId: randomUUID(), pid: process.pid, hostname: hostname(), acquiredAt: this.now().toISOString() };
	}

	session(sessionId: string): SessionRecord {
		return this.project.createExecutionState({ now: this.now }).session(sessionId);
	}

	/** inbox 里还没进消息列表的作者消息数。 */
	pendingInbox(sessionId: string): number {
		const consumed = this.session(sessionId).inboxSequence ?? 0;
		return this.project.readInbox(sessionId).filter((item) => item.sequence > consumed).length;
	}

	/** 带 commandId 新建的 session 的 id 由命令决定：重发同一命令拿回同一个 session。 */
	sessionIdForCommand(commandId: string): string {
		return `session_${createHash("sha256").update(commandId).digest("hex")}`;
	}

	hasSession(sessionId: string): boolean {
		return this.project.loadExecutionEntities().sessions.some((session) => session.id === sessionId);
	}

	/**
	 * 新建 session。同一 commandId 重复调用返回同一个 session；模型在这里绑定一次，之后只在 turn 边界换。
	 * rank 之类脚本驱动的 session 不绑根模型。
	 */
	async createSession(
		input: { commandId?: string; kind?: SessionKind; model?: ModelChoice; binding?: ModelBindingSnapshot } = {},
	): Promise<SessionRecord> {
		const execution = this.project.createExecutionState({ now: this.now });
		const id = input.commandId === undefined ? `session_${randomUUID()}` : this.sessionIdForCommand(input.commandId);
		if (execution.hasSession(id)) return execution.session(id);
		const kind = input.kind ?? "agent";
		const binding =
			kind === "agent" ? (input.binding ?? (await this.#models.bind("main", input.model)).snapshot) : undefined;
		return execution.createSession({
			commandId: `${id}:create`,
			id,
			projectId: this.project.projectId,
			kind,
			...(binding === undefined ? {} : { model: binding }),
			baseRevisionId: await this.project.refreshHead(),
		});
	}

	/** 删 session 的执行记录；checkout 不动——它不属于任何 session，未提交的改动仍在 `project.diff` 里。 */
	deleteSession(sessionId: string): void {
		this.project.createExecutionState({ now: this.now }).deleteSession(`${sessionId}:delete`, sessionId);
	}

	/** turn 结束的对账：进事件不进 prompt，在 RUN_FINISHED 之前发出（Harness 设计第 3 节）。作者停下的 turn 带 stopped。 */
	async #emitTurnSummary(
		session: HarnessSession,
		start: TurnStart | undefined,
		turnId: string,
		stopped = false,
	): Promise<void> {
		if (start === undefined) return;
		let content: SuimingTurnSummary;
		try {
			const end = await session.scan();
			const status = await readProjectStatus(this.project, end, { stale: false });
			const writers = new Set(
				session.execution
					.tasksOf(session.sessionId)
					.filter((task) => task.model?.modelProfileId === "writer")
					.map((task) => task.id),
			);
			content = turnSummary(start.candidate, end, {
				authorMessages: (session.record.inboxSequence ?? 0) - start.inboxSequence,
				revisions: session.revisionsThisTurn,
				uncommitted: status.candidate.uncommittedChanges,
				textWithoutContext: textWrittenWithoutContext(
					session.events.durableEventsAfter(start.eventSequence),
					writers,
				),
			});
			if (stopped) content.stopped = true;
		} catch {
			// checkout 读不出来时这一轮本来就会失败，原因在 lastFailure 里，不再叠一层。
			return;
		}
		session.events.emit(
			{
				type: EventType.ACTIVITY_SNAPSHOT,
				messageId: `${turnId}:summary`,
				activityType: "suiming.turn",
				replace: true,
				content,
			},
			`${turnId}:summary`,
		);
	}

	/**
	 * 跑一个 turn：拿 lease → body → 收口。body 正常返回或模型停下 → idle；打断 → idle；
	 * 其余错误 → idle 并记 lastFailure，作者一句话就能续。持久化本身失败时抛出，不伪装成收口。
	 */
	async turn<T>(
		sessionId: string,
		options: TurnOptions,
		body: (session: HarnessSession) => Promise<T>,
	): Promise<TurnOutcome<T>> {
		if (options.signal?.aborted === true) throw new SuimingHarnessError("run_interrupted", "turn 开始前已被打断");
		const execution = this.project.createExecutionState({ now: this.now });
		const before = execution.session(sessionId);
		if (before.status === "running")
			throw new SuimingHarnessError("session_running", `session ${sessionId} 已有 turn 在跑`);
		const lease = this.#lease();
		const ownerId = lease.ownerId as string;
		// 先订阅再 startTurn：RUN_STARTED 与紧随其后的状态快照由 startTurn 的命令落盘，订阅晚了它们就只在历史里，
		// `suim session send --events` 与桌面 attach 都收不到这个 turn 的开头（2026-10-04 补测试时发现）。
		const events = new SessionEventStream(sessionId, this.now, {
			history: this.project.readSessionEvents(sessionId),
			read: (after) => this.project.readSessionEvents(sessionId, after),
			persist: (event) => this.project.appendSessionEvents([event], { sessionId, ownerId }),
		});
		if (options.onEvent !== undefined) events.subscribe(options.onEvent);
		const record = execution.startTurn({
			commandId: `${sessionId}:turn:start:${before.version}`,
			sessionId,
			lease,
			turnId: ownerId,
			...(options.model === undefined ? {} : { model: options.model }),
		});
		execution.bindOwner(sessionId, ownerId);
		events.refresh();
		const endTurn = (failure?: ExecutionFailure): SessionRecord =>
			execution.endTurn({
				commandId: `${sessionId}:turn:end:${execution.session(sessionId).version}`,
				sessionId,
				...(failure === undefined ? {} : { failure }),
			});
		return this.telemetry.startSpan(
			{
				name: `suiming.turn ${record.kind}`,
				attributes: {
					"suiming.session.id": sessionId,
					"suiming.turn.id": ownerId,
					"suiming.turn": record.turn,
					"suiming.project.id": this.project.projectId,
					"langfuse.session.id": sessionId,
					"langfuse.trace.name": `suiming.turn ${record.kind}`,
				},
			},
			async (span) => {
				let session: HarnessSession | undefined;
				let start: TurnStart | undefined;
				try {
					await options.onStarted?.({ sessionId, turnId: ownerId });
					// 基线永远是当前 head：没有 worktree，checkout 里的候选就是相对 head 的。作者在两个 turn
					// 之间提交过时把 session 基线推到 head，附注只在紧随其后的那一个 turn 说「有新提交」。
					// 先从 canon ref 重读：别的进程（CLI、host 的 suim commit）可能刚推进过 Canon。
					const headRevisionId = await this.project.refreshHead();
					const headMoved = record.baseRevisionId !== undefined && record.baseRevisionId !== headRevisionId;
					if (headMoved)
						execution.advanceSessionRevision(
							`${sessionId}:turn:${record.turn}:rebase`,
							sessionId,
							record.baseRevisionId as string,
							headRevisionId,
						);
					session = new HarnessSession(this, {
						sessionId,
						base: await this.project.historyReader().snapshot(headRevisionId),
						headMoved,
						execution,
						events,
						signal: options.signal,
						telemetry: span,
						usageCheckpoint: await this.#usageCheckpoint(),
					});
					events.refresh();
					start = await turnStart(session);
					const value = await body(session);
					await this.#emitTurnSummary(session, start, ownerId);
					const ended = endTurn();
					events.refresh();
					return { session: ended, value };
				} catch (error) {
					// 持久化已经失败的实例不能再记账；把原错误抛回，状态留给下一次 open 收敛。
					execution.assertWritable();
					events.assertWritable();
					const failure = executionFailure(error);
					const interrupted = failure.code === "run_interrupted" || options.signal?.aborted === true;
					// 失败或被打断的 turn 也报这一轮改了什么；对账本身出错不能盖住原来的失败。停下的 turn 标出来：
					// 没有它，对话里只剩一串操作、后面没有回复，作者看不出是自己停的还是出了什么事。
					if (session !== undefined)
						await this.#emitTurnSummary(session, start, ownerId, interrupted).catch(() => undefined);
					const ended = interrupted ? endTurn() : endTurn(failure);
					events.refresh();
					return { session: ended, ...(interrupted ? {} : { failure }) };
				} finally {
					const latest = execution.session(sessionId);
					span.setAttributes({
						...usageAttributes("suiming.session", latest.usage ?? emptyModelUsage()),
						"suiming.session.status": latest.status,
					});
				}
			},
		);
	}

	/** 从已完成 Task 的结果对象装回 TaskOutcome；续跑复用已完成的子任务时走这里。 */
	async readTaskOutcome(task: TaskRecord): Promise<TaskOutcome> {
		if (task.result?.kind !== "object")
			throw new ArtifactError("task_result_missing", `Completed Task ${task.id} has no result object`);
		const object = await this.project.readExecutionObject(task.result.id);
		const parsed = parseExecutionJson(object.bytes, `Task ${task.id} result`) as Partial<TaskResultObject>;
		if (parsed.schemaVersion !== 4 || typeof parsed.turns !== "number" || parsed.usage === undefined)
			throw new ArtifactError("invalid_task_result", `Completed Task ${task.id} has an unreadable result object`);
		return {
			taskId: task.id,
			resultObjectId: task.result.id,
			loop: { stop: "terminated", turns: parsed.turns, usage: parsed.usage, messages: [] },
			result: parsed.result,
		};
	}
}

export type { SessionEvent };

/** 只投影对象标识；文件内容和完整工具参数不进入活动摘要。resume_task 的 taskId 让对话把它放进续的那个子任务那一行。 */
function actionTarget(args: unknown): { target?: string } {
	if (!args || typeof args !== "object") return {};
	const fields = args as Record<string, unknown>;
	for (const key of ["path", "storyBeatId", "query", "messageId", "resultObjectId", "taskId"]) {
		if (typeof fields[key] === "string" && fields[key]) return { target: [...fields[key]].slice(0, 160).join("") };
	}
	return {};
}
