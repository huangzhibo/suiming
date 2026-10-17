import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type AssistantMessage,
	type Context,
	calculateCost,
	isContextOverflow,
	isRetryableAssistantError,
	type Message,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import { Value } from "typebox/value";
import { addModelUsage, emptyModelUsage } from "../execution/model-usage.js";
import type { ModelUsage } from "../execution/types.js";
import type { BoundModelProfile } from "../model/model-gateway.js";
import { captureTelemetryContent } from "../model/telemetry-content.js";
import { compactionContext, compactionCut } from "./context-compaction.js";
import { SuimingHarnessError } from "./errors.js";
import { type HarnessTool, type HarnessToolResult, rejectionForToolError, ToolRejection } from "./tool.js";

export interface TaskLoopBudget {
	maxTurns: number;
}
export interface TaskLoopToolCallEvent {
	toolCallId: string;
	actionId: string;
	toolName: string;
	args: unknown;
	isError: boolean;
	summary: string;
}
export interface ModelCallRecord {
	id: string;
	turn: number;
	/**
	 * prepared 是登记了还没发；effect_pending 是可能已经发出；unknown 是发出后没收到完整回复、已经作废——
	 * 进程退出或流抛出异常时落到这里，恢复不核对它，回到 ready 用当前消息重新组装（可能已计费，用量里记一次未确认调用）。
	 */
	state: "prepared" | "effect_pending" | "received" | "failed" | "unknown";
	response?: AssistantMessage;
	usage?: ModelUsage;
	usageRecorded?: boolean;
	interrupted?: boolean;
	/** 发出去的请求的字节数；与返回的 input tokens 一起校准下一次请求的大小估计。 */
	promptBytes?: number;
	purpose?: "compaction";
}
export interface ActionRecord {
	id: string;
	modelCallId: string;
	call: ToolCall;
	/**
	 * planned 是还没开始；effect_pending 是已经开始执行、还没拿到结果。从 checkpoint 接着跑时这两种都不重做，
	 * 补一条「没有执行」或「执行时被打断」的结果交给模型（interruptedResult）。
	 */
	state: "planned" | "effect_pending" | "result_ready" | "delivered";
	result?: HarnessToolResult;
	message?: ToolResultMessage;
}
/** 一个 loop（根 session 或子任务）的 checkpoint 的模型 / 工具部分；不是另一个会话存储。 */
export interface LoopCheckpoint {
	schemaVersion: 2;
	/** 这份 checkpoint 属于哪个 loop：sessionId 或 taskId。 */
	loopId: string;
	sequence: number;
	steeringSequence: number;
	/** 最近一次摘要及替代的历史边界；原消息保持完整。 */
	reduction?: {
		throughMessage: number;
		actionId?: string;
		modelCallId: string;
		summary?: string;
		/** 压缩那一刻的开场快照，请求里替换第一条消息（只有根 Agent 有：它的开场是作品快照，子任务的开场是任务本身）。 */
		opening?: string;
	};
	/** 正在生成摘要的历史边界；请求中断后按同一边界重新组装。 */
	compacting?: { throughMessage: number };
	/** 最近一个边界之后第一条消息的下标；它之前的大读取结果在请求里折成头尾（见 FOLD_BYTES）。只往前推。 */
	boundary?: number;
	/** 上一次请求被 provider 以上下文超限拒绝、已经清理重试过；再超限就如实报错，不无限重发。 */
	overflowRetried?: boolean;
	/** 这一次请求因瞬时失败已重发了几次；拿到正常响应就清掉。 */
	transientRetries?: number;
	/** 最近一个动作的指纹（工具名 + 参数 + 结果）与它连续出现的次数，成功与被拒都算。 */
	repeated?: { fingerprint: string; count: number };
	/** 连续几次回复里的动作全被拒绝（不论是不是同一个）；有动作成功或作者插话就清零。 */
	rejectedStreak?: number;
	/** 子任务连续停下却没有调用交付工具的次数，随 checkpoint 续跑保留。 */
	unsubmittedStops?: number;
	phase: "ready" | "model_pending" | "tools" | "settled";
	messages: Message[];
	calls: ModelCallRecord[];
	actions: ActionRecord[];
	turns: number;
	usage: ModelUsage;
	stop?: TaskLoopOutcome["stop"];
	submission?: unknown;
}
export interface TaskLoopOptions {
	model: BoundModelProfile;
	systemPrompt: string;
	/** 第一条 user 消息；根 session 不给（第一条作者消息从 inbox 来）。 */
	prompt?: string;
	/** 子任务给：第一次请求的估计输入超过窗口的这个比例就不发，报 `delegation_too_large`（见 TASK_OPENING_AT）。 */
	openingLimit?: number;
	tools: HarnessTool[];
	budget: TaskLoopBudget;
	signal?: AbortSignal;
	telemetryContext?: TelemetryContext;
	loopId?: string;
	checkpoint?: LoopCheckpoint;
	/** 确认保存之后才调用 provider、修改文件或交付工具结果。 */
	saveCheckpoint?(checkpoint: LoopCheckpoint): Promise<void>;
	captureSubmission?(): unknown;
	/** 瞬时失败（流中断、429、5xx）的自动重发；缺省见 TRANSIENT_RETRY。 */
	transientRetry?: { maxRetries: number; baseDelayMs: number };
	refreshOpening?(): Promise<string>;
	onProgress?(id: string, label: string, status: "running" | "completed" | "failed", summary?: string): void;
	onTurnStart?(turn: number, context: Context): Promise<void> | void;
	onTextDelta?(delta: string, callId: string): void;
	onMessage?(callId: string, message: AssistantMessage): void;
	onToolCall?(event: TaskLoopToolCallEvent): void;
	onModelCall?(usage: ModelUsage, callId: string, cumulative: ModelUsage): void;
	steering?(): Promise<{ sequence: number; text: string }[]> | { sequence: number; text: string }[];
	onSteer?(text: string, sequence: number): void;
	/** 作者消息进消息列表前的确定性附注（head、候选状态）；只改进模型看到的文本，事件里仍是原话。 */
	decorateSteering?(text: string, sequence: number): string | Promise<string>;
	/**
	 * 目标的自动续跑（ADR-0038）：模型上一轮停下、没有作者新消息时，把这条系统写的 user 消息接进消息列表，
	 * 再开一次请求。它不是作者说的，不进 inbox，也不推进 steeringSequence。
	 */
	continuation?: string;
}
export interface TaskLoopOutcome {
	stop: "terminated" | "model_stopped" | "budget_exhausted";
	turns: number;
	usage: ModelUsage;
	messages: Message[];
	submission?: unknown;
}
/**
 * 瞬时失败在同一个 turn 里退避重发：2 / 4 / 8 / 16 / 30 秒，共约一分钟，与 Codex 默认的流中断重试 5 次同量级。
 * 哪些算瞬时由 pi-ai 的 isRetryableAssistantError 判（`terminated`、`fetch failed`、429、5xx 算；订阅额度用尽、401 不算）。
 * 2026-10-02 之前一次 `terminated` 就结束整个 turn，长时间的自主运行停在半路等作者说一句「继续」。
 */
const TRANSIENT_RETRY = { maxRetries: 5, baseDelayMs: 2_000, maxDelayMs: 30_000 };
/**
 * 进展型兜底（Harness 设计第 4 节）。第一道：同一个动作（工具名 + 参数）得到同一个结果连续这么多次，成功的也算——
 * 结果没变，再做一次也不会变。2026-10-04 之前只认被拒的动作，拦不住 opencode 那种把同一个 grep 成功执行 364 次的
 * 子任务；Gemini CLI（同一调用连续 5 次）与 OpenHands（同一动作与观察 4 次、同一错误 3 次）都不分成败。
 */
const NO_PROGRESS_REPEATS = 3;
/**
 * 第二道：换着花样被拒（每次参数不同）连续这么多次回复也停。一次回复里只要有一个动作成功就不算；
 * 正常的试错——改错了、读一下、再改——中间总有成功的读。
 */
const NO_PROGRESS_STREAK = 5;
function interruptedError(signal: AbortSignal | undefined): SuimingHarnessError {
	const reason = signal?.reason;
	return new SuimingHarnessError(
		"run_interrupted",
		reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "turn was interrupted",
	);
}
function usageOfMessage(model: BoundModelProfile["model"], message: AssistantMessage): ModelUsage {
	const cost =
		message.usage.cost.total > 0 || message.usage.totalTokens === 0
			? message.usage.cost
			: calculateCost(model, { ...message.usage, cost: { ...message.usage.cost } });
	return {
		calls: 1,
		input: message.usage.input,
		output: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
		reasoning: message.usage.reasoning ?? 0,
		totalTokens: message.usage.totalTokens,
		costUsd: cost.total,
	};
}

function summarize(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
	const joined = Array.isArray(content)
		? content
				.filter((item) => item.type === "text" && typeof item.text === "string")
				.map((item) => item.text as string)
				.join("\n")
		: "";
	const codePoints = Array.from(joined);
	return codePoints.length <= 200 ? joined : `${codePoints.slice(0, 200).join("")}…`;
}

/** 输入预留两成给输出与工具；自动摘要保留最近约两成窗口。 */
const COMPACT_AT = 0.8;
export const TASK_OPENING_AT = 0.7;
/** 没有校准数据时按每 3 字节 1 token 估：中文一个字 3 字节，偏保守。 */
const DEFAULT_TOKENS_PER_BYTE = 1 / 3;

/**
 * 边界折叠（Harness 设计第 7 节「边界折叠」）。边界是上一轮停下之后作者又说了一句，以及一次产生了新版本的提交：
 * 之前读到的东西，用它的那件事已经做完了。边界之前、原文超过这么多字节的读取类结果（工具声明 `rereadable`，同样的
 * 参数再调一次就拿得回来，拿到的还是当前内容）在请求里只留头尾。不按「发过几次」折：模型常常一次读一个文件、
 * 读完几个才动笔，按次数折会在动笔之前折掉先读的，逼它重读。折叠点只在边界上推进，两个边界之间请求前缀不变。
 */
const FOLD_BYTES = 10 * 1024;
const FOLD_EXCERPT_CODE_POINTS = 200;

function textOf(message: ToolResultMessage): string {
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** 产生这个工具结果的调用参数：在它前面最近的那条模型回复里。 */
function callArguments(messages: readonly Message[], index: number, toolCallId: string): string {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const message = messages[cursor];
		if (message?.role !== "assistant") continue;
		const call = message.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
		const encoded = call?.type === "toolCall" ? Array.from(JSON.stringify(call.arguments)) : [];
		return encoded.length <= FOLD_EXCERPT_CODE_POINTS
			? encoded.join("")
			: `${encoded.slice(0, FOLD_EXCERPT_CODE_POINTS).join("")}…`;
	}
	return "";
}

function foldedToolResult(messages: readonly Message[], index: number, message: ToolResultMessage): ToolResultMessage {
	const { details: _details, ...rest } = message;
	const codePoints = Array.from(textOf(message));
	const head = codePoints.slice(0, FOLD_EXCERPT_CODE_POINTS).join("");
	const tail = codePoints.slice(-FOLD_EXCERPT_CODE_POINTS).join("");
	return {
		...rest,
		content: [
			{
				type: "text",
				text: `[已折叠：上一个边界（新一轮或提交）之前的 ${message.toolName} ${callArguments(messages, index, message.toolCallId)}，原文 ${codePoints.length} 字，只留头尾。要用全文就用同样的参数再调用一次，拿到的是当前内容]\n${head}\n……\n${tail}`,
			},
		],
	};
}

/** 边界之前的大读取结果折成头尾，其余原样。 */
function projectToolResult(state: LoopCheckpoint, index: number, foldable: ReadonlySet<string>): ToolResultMessage {
	const message = state.messages[index] as ToolResultMessage;
	if (
		index < (state.boundary ?? 0) &&
		foldable.has(message.toolName) &&
		Buffer.byteLength(textOf(message)) > FOLD_BYTES
	)
		return foldedToolResult(state.messages, index, message);
	return message;
}

/** 请求投影：开场、合并摘要、最新作者原话、近期完整交互；原历史不改。 */
function projectMessages(state: LoopCheckpoint, foldable: ReadonlySet<string>): Message[] {
	const project = (message: Message, index: number): Message =>
		message.role === "toolResult" ? projectToolResult(state, index, foldable) : message;
	if (!state.reduction) return state.messages.map(project);
	// 旧恢复点的摘要曾放在工具参数里；读出后使用同一投影，不改变历史文件。
	let cut = state.reduction.throughMessage;
	let summary = state.reduction.summary;
	if (summary === undefined) {
		while (cut > 0 && state.messages[cut - 1]?.role !== "assistant") cut--;
		cut = Math.max(1, cut - 1);
		const action = state.actions.find((item) => item.id === state.reduction?.actionId);
		summary = action?.result?.contextSummary ?? "";
	}
	const first = state.messages[0];
	return [
		...(first
			? [
					{
						...first,
						...(state.reduction.opening === undefined ? {} : { content: state.reduction.opening }),
					} as Message,
				]
			: []),
		{
			role: "user",
			content: `[执行摘要：历史原文仍保存在对话记录中；作品事实以当前文件为准]\n${summary}`,
			timestamp: 0,
		},
		...(state.messages.findLastIndex((message) => message.role === "user") > 0 &&
		state.messages.findLastIndex((message) => message.role === "user") < cut
			? [state.messages[state.messages.findLastIndex((message) => message.role === "user")] as Message]
			: []),
		...state.messages.slice(cut).map((message, offset) => project(message, cut + offset)),
	];
}

function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/** 最近一次正常返回的请求：input tokens / 请求字节数。 */
function tokensPerByte(state: LoopCheckpoint): number {
	for (let index = state.calls.length - 1; index >= 0; index -= 1) {
		const call = state.calls[index];
		if (call?.purpose === "compaction" || call?.state !== "received" || !call.usage || !call.promptBytes) continue;
		const prompt = call.usage.input + call.usage.cacheRead + call.usage.cacheWrite;
		if (prompt > 0) return prompt / call.promptBytes;
	}
	return DEFAULT_TOKENS_PER_BYTE;
}

function contextOverflowError(): SuimingHarnessError {
	return new SuimingHarnessError(
		"context_overflow",
		"本次输入超过模型的上下文上限，现有历史无法再安全压缩。请缩小本次材料范围或换用更大窗口的模型；作品与对话记录已保留。",
	);
}

/** 还没开始的动作在恢复时得到的结果。 */
const NOT_RUN = "没有执行：这一批动作在它之前被打断了（作者停止、应用退出或进程中断）。需要的话重新调用。";
/** 执行到一半的动作在恢复时得到的结果；工具可以用 interrupted 再补一句（子任务的进度、提交成了哪个版本）。 */
const INTERRUPTED =
	"执行时被打断了（作者停止、应用退出或进程中断），不确定有没有生效。需要的话先读一下相关文件或作品状态，再决定重做还是接着做别的。";

/**
 * Suiming 自有循环。所有已接受的模型决定与工具结果先确认保存，再推进执行位置。
 * 从 checkpoint 接着跑时不核对半途的效果（Harness 设计第 5 节）：没收到回复的请求作废重发，没有结果的动作补一条
 * 「被打断」或「没有执行」，由模型看着决定——与 Claude Code、Codex 的做法相同。模型与工具面一律用当前的。
 */
export async function runTaskLoop(options: TaskLoopOptions): Promise<TaskLoopOutcome> {
	const declarations = options.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	const foldable = new Set(options.tools.filter((tool) => tool.rereadable).map((tool) => tool.name));
	const state: LoopCheckpoint =
		options.checkpoint === undefined
			? {
					schemaVersion: 2,
					loopId: options.loopId ?? `loop_${randomUUID()}`,
					sequence: 0,
					steeringSequence: 0,
					phase: "ready",
					messages:
						options.prompt === undefined
							? []
							: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
					calls: [],
					actions: [],
					turns: 0,
					usage: emptyModelUsage(),
				}
			: structuredClone(options.checkpoint);
	if (state.schemaVersion !== 2 || (options.loopId !== undefined && state.loopId !== options.loopId))
		throw new SuimingHarnessError("checkpoint_invalid", "恢复位置不属于这个 loop");
	// 10-06 之前的 checkpoint 还带着按 turn 冻结的绑定 hash，现在不用了。
	Reflect.deleteProperty(state, "binding");
	if (
		!["ready", "model_pending", "tools", "settled"].includes(state.phase) ||
		!Number.isInteger(state.sequence) ||
		state.sequence < 0 ||
		!Array.isArray(state.messages) ||
		!Array.isArray(state.calls) ||
		!Array.isArray(state.actions)
	)
		throw new SuimingHarnessError("checkpoint_invalid", "恢复位置形状无效");
	const callIds = new Set(state.calls.map((call) => call.id));
	const actionIds = new Set(state.actions.map((action) => action.id));
	if (
		callIds.size !== state.calls.length ||
		actionIds.size !== state.actions.length ||
		state.actions.some(
			(action) =>
				!callIds.has(action.modelCallId) ||
				(["result_ready", "delivered"].includes(action.state) && (!action.result || !action.message)),
		)
	)
		throw new SuimingHarnessError("checkpoint_invalid", "恢复位置包含重复身份、缺失请求或未保存的结果");
	const check = () => {
		if (options.signal?.aborted) throw interruptedError(options.signal);
	};
	// 消息、Context、动作输入 / 结果一经确认不再修改；只克隆一次并跨恢复点复用。
	// 可变的推进记录每次复制，不能让后续状态推进改写已经交给存储的快照。
	const copies = new WeakMap<object, unknown>();
	const freezeCopy = (value: unknown): void => {
		if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || Object.isFrozen(value)) return;
		for (const child of Object.values(value)) freezeCopy(child);
		Object.freeze(value);
	};
	const immutableCopy = <T>(value: T): T => {
		if (value === null || typeof value !== "object") return value;
		if (!copies.has(value)) {
			const copy = structuredClone(value);
			freezeCopy(copy);
			copies.set(value, copy);
		}
		return copies.get(value) as T;
	};
	// 并行动作会交错保存：快照在调用时同步取，写入排队，后取的快照一定后落盘，旧快照不会盖掉新的。
	let writing: Promise<void> = Promise.resolve();
	const save = () => {
		state.sequence += 1;
		const snapshot: LoopCheckpoint = {
			...state,
			messages: state.messages.map(immutableCopy),
			calls: state.calls.map((call) => ({
				...call,
				...(call.response ? { response: immutableCopy(call.response) } : {}),
				...(call.usage ? { usage: immutableCopy(call.usage) } : {}),
			})),
			actions: state.actions.map((action) => ({
				...action,
				call: immutableCopy(action.call),
				...(action.result ? { result: immutableCopy(action.result) } : {}),
				...(action.message ? { message: immutableCopy(action.message) } : {}),
			})),
			usage: { ...state.usage },
			...(state.reduction ? { reduction: { ...state.reduction } } : {}),
			...(state.compacting ? { compacting: { ...state.compacting } } : {}),
			...(state.repeated ? { repeated: { ...state.repeated } } : {}),
			...(state.submission !== undefined ? { submission: immutableCopy(state.submission) } : {}),
		};
		const written = writing.then(() => options.saveCheckpoint?.(snapshot));
		writing = written.then(
			() => undefined,
			() => undefined,
		);
		return written;
	};
	const pullSteering = async () => {
		const pending = ((await options.steering?.()) ?? []).filter((item) => item.sequence > state.steeringSequence);
		// 模型说完停下之后作者又说了一句，是一个边界；模型还在干活时的插话不是，正在用的读取结果不能折。
		const last = state.messages.at(-1);
		if (pending.length > 0 && last?.role === "assistant" && !last.content.some((part) => part.type === "toolCall"))
			state.boundary = state.messages.length;
		for (const item of pending) {
			state.messages.push({
				role: "user",
				content: (await options.decorateSteering?.(item.text, item.sequence)) ?? item.text,
				timestamp: Date.now(),
			});
			state.steeringSequence = item.sequence;
			delete state.repeated;
			delete state.rejectedStreak;
			delete state.unsubmittedStops;
			await save();
			options.onSteer?.(item.text, item.sequence);
		}
		return pending.length;
	};
	const finish = async (stop: TaskLoopOutcome["stop"]): Promise<TaskLoopOutcome> => {
		state.phase = "settled";
		state.stop = stop;
		await save();
		return {
			stop,
			turns: state.turns,
			usage: state.usage,
			messages: state.messages,
			...(state.submission === undefined ? {} : { submission: state.submission }),
		};
	};
	const finishTerminated = async (): Promise<TaskLoopOutcome | undefined> => {
		state.phase = "tools";
		delete state.stop;
		if ((await pullSteering()) === 0) return finish("terminated");
		// 模型提交的回答早于补充要求；保留动作历史，再给模型一轮处理已接收的新消息。
		state.phase = "ready";
		delete state.stop;
		delete state.submission;
		await pullSteering();
		await save();
		return undefined;
	};
	// checkpoint 确认后事件发布可能失败；恢复时补齐已应用指令的持久消息，事件 id 保持不变。
	for (const item of (await options.steering?.()) ?? []) {
		if (item.sequence <= state.steeringSequence) options.onSteer?.(item.text, item.sequence);
	}
	if (state.phase === "settled") {
		// 模型停下之后又来了作者消息：接着同一份消息列表跑，而不是把旧的 settled 结果再交一次。
		if (state.stop !== "terminated" && (await pullSteering()) === 0)
			return finish(state.stop as TaskLoopOutcome["stop"]);
		if (state.stop !== "terminated") {
			state.phase = "ready";
			delete state.stop;
			await save();
		} else {
			const result = await finishTerminated();
			if (result) return result;
		}
	}
	if (options.continuation !== undefined && state.phase === "ready" && state.messages.at(-1)?.role === "assistant") {
		// 和作者在模型停下之后说话一样是一个边界：上一轮读过的大结果可以折
		state.boundary = state.messages.length;
		state.messages.push({ role: "user", content: options.continuation, timestamp: Date.now() });
		delete state.repeated;
		delete state.rejectedStreak;
		await save();
	}
	check();
	// 没有拿到可用回复的调用（打断、provider 报错、输出被截断）不能把下一次续跑也钉死在同一个错误上：
	// 撤回那条响应，回到 ready 重新请求。计费记录照记，不抹除。
	const last = state.calls.at(-1);
	if (
		state.phase === "tools" &&
		last !== undefined &&
		(last.interrupted || last.state === "failed" || last.response?.stopReason === "length")
	) {
		if (last.usage && !last.usageRecorded) {
			options.onModelCall?.(last.usage, last.id, state.usage);
			last.usageRecorded = true;
		}
		if (last.purpose !== "compaction") state.messages.pop();
		state.phase = "ready";
		await save();
	}
	// 没收到回复的请求作废：回到 ready 用当前消息重新组装，带上这期间来的作者消息，不按旧请求补发。
	// 登记了还没发的直接撤掉；可能已经发出的留下记录（unknown），它的未确认调用已经记在用量里。
	if (state.phase === "model_pending") {
		if (last?.state === "prepared") {
			state.calls.pop();
			state.turns -= 1;
		} else if (last !== undefined) last.state = "unknown";
		state.phase = "ready";
		await save();
	}
	// 一批动作做到一半被打断：已有结果的照常交付，其余补一条结果，不重做、不核对，由模型看着决定。
	if (state.phase === "tools" && last !== undefined) {
		const pending = state.actions.filter(
			(action) =>
				action.modelCallId === last.id && (action.state === "planned" || action.state === "effect_pending"),
		);
		for (const action of pending) {
			let text = NOT_RUN;
			if (action.state === "effect_pending") {
				const tool = options.tools.find((item) => item.name === action.call.name);
				const note =
					tool?.interrupted !== undefined && Value.Check(tool.parameters, action.call.arguments)
						? await tool.interrupted(action.id, action.call.arguments)
						: undefined;
				text = note === undefined ? INTERRUPTED : `${INTERRUPTED}\n${note}`;
			}
			action.result = { content: [{ type: "text", text }] };
			action.message = {
				role: "toolResult",
				toolCallId: action.call.id,
				toolName: action.call.name,
				content: action.result.content,
				isError: true,
				timestamp: Date.now(),
			};
			action.state = "result_ready";
		}
		if (pending.length > 0) await save();
	}
	/** 把一个动作推进到 result_ready：先记下「已开始」，再执行。交付（进消息列表）另由调用方按派出顺序做。 */
	const settle = async (action: ActionRecord, call: ModelCallRecord) => {
		const tool = options.tools.find((item) => item.name === action.call.name);
		let result!: HarnessToolResult;
		let isError = false;
		await (options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT).startSpan(
			{
				name: `suiming.tool ${action.call.name}`,
				attributes: {
					"langfuse.observation.type": "tool",
					"langfuse.observation.metadata.action_id": action.id,
					"langfuse.observation.metadata.model_call_id": call.id,
				},
			},
			async (toolSpan) => {
				captureTelemetryContent(toolSpan, "input", () => action.call.arguments);
				try {
					if (!tool) throw new ToolRejection("unknown_tool", action.call.name);
					if (!Value.Check(tool.parameters, action.call.arguments))
						throw new ToolRejection(
							"invalid_tool_arguments",
							[...Value.Errors(tool.parameters, action.call.arguments)]
								.map((error) => `${error.instancePath}: ${error.message}`)
								.join("; "),
						);
					// 先记下「已开始」：恢复时据此区分「执行时被打断」与「没有执行」。
					action.state = "effect_pending";
					await save();
					options.onProgress?.(action.id, action.call.name, "running");
					check();
					result = await tool.execute(action.id, action.call.arguments, options.signal);
				} catch (thrown) {
					const error = rejectionForToolError(thrown);
					toolSpan.setStatus({
						status: "error",
						error: {
							name: error instanceof ToolRejection ? error.code : "ToolError",
							message: "Tool action failed",
						},
					});
					// 写冲突也在这里交给模型：落盘前核对过，这次没有写入，模型重读再改就行。
					if (!(error instanceof ToolRejection)) throw error;
					result = { content: [{ type: "text", text: error.message }] };
					isError = true;
				}
				captureTelemetryContent(toolSpan, "output", () => ({ content: result.content, isError }));
			},
		);
		action.result = result;
		action.message = {
			role: "toolResult",
			toolCallId: action.call.id,
			toolName: action.call.name,
			content: result.content,
			...(result.details === undefined ? {} : { details: result.details }),
			isError,
			timestamp: Date.now(),
		};
		if (result.terminate) state.submission = options.captureSubmission?.() ?? state.submission;
		action.state = "result_ready";
		await save();
	};
	// 这一次请求的输入只在内存里：恢复时没收到回复的请求作废、从消息列表重新组装，checkpoint 不必存它。
	let request: Context | undefined;
	mainLoop: while (true) {
		check();
		if (state.phase === "ready") {
			await pullSteering();
			if (state.turns >= options.budget.maxTurns) return finish("budget_exhausted");
			// 回复已经在消息列表里，调用记录不再留一份。10-06 之前的 checkpoint 还在调用记录里存过请求的 Context。
			for (const previous of state.calls) {
				delete previous.response;
				Reflect.deleteProperty(previous, "context");
			}
			const build = (): Context => ({
				systemPrompt: options.systemPrompt,
				messages: structuredClone(projectMessages(state, foldable)),
				tools: declarations,
			});
			let context = build();
			let promptBytes = bytesOf(context);
			const window = options.model.model.contextWindow;
			if (window > 0) {
				const ratio = tokensPerByte(state);
				if (
					options.openingLimit !== undefined &&
					state.turns === 0 &&
					promptBytes * ratio > window * options.openingLimit
				)
					throw new SuimingHarnessError(
						"delegation_too_large",
						`子任务的开场输入过大（估计 ${Math.ceil(promptBytes * ratio)} token，当前模型预留后的上限 ${Math.floor(window * options.openingLimit)} token），请把材料或情节范围拆小，或换用更大窗口的模型；尚未发送模型请求。`,
					);
				if (!state.compacting && promptBytes * ratio > window * COMPACT_AT) {
					const cut = compactionCut(state.messages, state.reduction?.throughMessage ?? 1, window);
					if (cut !== undefined) state.compacting = { throughMessage: cut };
					else if (promptBytes * ratio > window) throw contextOverflowError();
				}
				if (state.compacting) {
					context = compactionContext(
						state.messages,
						state.compacting.throughMessage,
						state.reduction,
						state.actions,
						window,
					);
					promptBytes = bytesOf(context);
				}
			}

			state.turns += 1;
			await options.onTurnStart?.(state.turns, context);
			check();
			state.calls.push({
				id: `call_${randomUUID()}`,
				turn: state.turns,
				state: "prepared",
				promptBytes,
				...(state.compacting ? { purpose: "compaction" as const } : {}),
			});
			state.phase = "model_pending";
			request = context;
			await save();
		}
		if (state.phase === "model_pending") {
			const call = state.calls.at(-1);
			if (call?.state !== "prepared" || request === undefined)
				throw new SuimingHarnessError("checkpoint_invalid", "模型调用恢复位置无效");
			const context = request;
			request = undefined;
			check();
			call.state = "effect_pending";
			await save();
			if (call.purpose === "compaction") options.onProgress?.(call.id, "整理上下文", "running");
			if (options.signal?.aborted) {
				// 停在这里时请求确定没发出，退回 prepared，恢复时直接撤掉。
				call.state = "prepared";
				await save();
				throw interruptedError(options.signal);
			}
			const abort = new AbortController();
			const onAbort = () => abort.abort(options.signal?.reason);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			let response: AssistantMessage;
			try {
				const stream = options.model.stream(context, {
					modelCallId: call.id,
					...(call.purpose === undefined ? {} : { purpose: call.purpose }),
					signal: abort.signal,
					...(options.loopId === undefined ? {} : { sessionId: options.loopId }),
					...(options.telemetryContext === undefined ? {} : { telemetryContext: options.telemetryContext }),
				});
				for await (const event of stream) {
					if (call.purpose !== "compaction" && event.type === "text_delta" && event.delta)
						options.onTextDelta?.(event.delta, call.id);
				}
				response = await stream.result();
			} catch (error) {
				abort.abort(error);
				if (options.signal?.aborted) throw interruptedError(options.signal);
				// 流本身抛了异常（pi-ai 通常把错误转成回复，很少走到这里）：这次请求作废，作者说一句就重新请求。
				// 它可能已经计费，未确认调用已经记在用量里。持久化错误由调用方的 latch 拦截。
				call.state = "unknown";
				state.phase = "ready";
				await save();
				throw new SuimingHarnessError("model_call_failed", error instanceof Error ? error.message : String(error));
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
			call.response = response;
			if (options.signal?.aborted) call.interrupted = true;
			call.usage = usageOfMessage(options.model.model, response);
			state.usage = addModelUsage(state.usage, call.usage);
			call.state = response.stopReason === "error" || response.stopReason === "aborted" ? "failed" : "received";
			if (call.purpose !== "compaction") state.messages.push(response);
			state.actions.push(
				...(call.purpose === "compaction" ? [] : response.content)
					.filter((part): part is ToolCall => part.type === "toolCall")
					.map(
						(toolCall): ActionRecord => ({
							id: `action_${randomUUID()}`,
							modelCallId: call.id,
							call: toolCall,
							state: "planned",
						}),
					),
			);
			state.phase = "tools";
			await save();
		}
		const call = state.calls.at(-1);
		if (!call?.response || !call.usage) throw new SuimingHarnessError("checkpoint_invalid", "缺少已确认的模型响应");
		if (call.purpose !== "compaction") options.onMessage?.(call.id, call.response);
		if (!call.usageRecorded) {
			options.onModelCall?.(call.usage, call.id, state.usage);
			call.usageRecorded = true;
			await save();
		}
		check();
		if (call.response.stopReason === "aborted") throw interruptedError(options.signal);
		if (call.purpose === "compaction" && call.response.stopReason !== "error") {
			const summary = call.response.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n")
				.trim();
			if (
				call.response.stopReason !== "stop" ||
				!summary ||
				call.response.content.some((part) => part.type === "toolCall")
			) {
				state.phase = "ready";
				await save();
				options.onProgress?.(call.id, "整理上下文", "failed", "摘要没有完整生成，原历史已保留");
				throw new SuimingHarnessError("model_output_truncated", "摘要没有完整生成，原历史已保留；继续即可重试。");
			}
			const opening = await options.refreshOpening?.();
			state.reduction = {
				throughMessage:
					state.compacting?.throughMessage ??
					(() => {
						throw new Error("Missing compaction boundary");
					})(),
				modelCallId: call.id,
				summary,
				...(opening === undefined ? {} : { opening }),
			};
			delete state.compacting;
			delete state.transientRetries;
			state.phase = "ready";
			await save();
			options.onProgress?.(call.id, "整理上下文", "completed", "已保留当前要求与未完成事项");
			continue;
		}
		if (
			(call.response.stopReason === "error" || call.response.stopReason === "length") &&
			isContextOverflow(call.response, options.model.model.contextWindow || undefined)
		) {
			if (call.purpose === "compaction" || state.overflowRetried) throw contextOverflowError();
			state.overflowRetried = true;
			state.messages.pop();
			state.actions = state.actions.filter((action) => action.modelCallId !== call.id);
			const cut = compactionCut(
				state.messages,
				state.reduction?.throughMessage ?? 1,
				options.model.model.contextWindow,
			);
			if (cut === undefined) throw contextOverflowError();
			state.compacting = { throughMessage: cut };
			state.phase = "ready";
			await save();
			continue;
		}

		if (call.response.stopReason === "error") {
			const policy = options.transientRetry ?? TRANSIENT_RETRY;
			const retries = state.transientRetries ?? 0;
			if (isRetryableAssistantError(call.response) && retries < policy.maxRetries) {
				// 与上下文超限同一种撤回：这次响应与它带出的工具调用都不算数，调用记录与用量照记。
				state.transientRetries = retries + 1;
				if (call.purpose !== "compaction") state.messages.pop();
				state.actions = state.actions.filter((action) => action.modelCallId !== call.id);
				state.phase = "ready";
				await save();
				if (call.purpose === "compaction")
					options.onProgress?.(call.id, "整理上下文", "failed", "请求失败，正在重试");
				try {
					const delay = Math.min(policy.baseDelayMs * 2 ** retries, TRANSIENT_RETRY.maxDelayMs);
					options.onProgress?.(
						`retry:${call.id}`,
						"自动重试",
						"running",
						`第 ${retries + 1} 次，${Math.ceil(delay / 1000)} 秒后重试`,
					);
					await sleep(delay, undefined, {
						...(options.signal === undefined ? {} : { signal: options.signal }),
					});
				} catch {
					throw interruptedError(options.signal);
				}
				options.onProgress?.(`retry:${call.id}`, "自动重试", "completed");
				continue;
			}
			options.onProgress?.(
				call.id,
				call.purpose === "compaction" ? "整理上下文" : "模型请求",
				"failed",
				call.response.errorMessage,
			);
			throw new SuimingHarnessError(
				"model_call_failed",
				`${call.response.errorMessage ?? "模型调用失败"}${retries > 0 ? `（同一请求已自动重试 ${retries} 次）` : ""}`,
			);
		}
		if (call.response.stopReason === "length")
			throw new SuimingHarnessError(
				"model_output_truncated",
				`模型输出达到 profile ${options.model.snapshot.modelProfileId} 的 maxTokens 上限，被截断`,
			);
		delete state.overflowRetried;
		delete state.transientRetries;
		const actions = state.actions.filter((action) => action.modelCallId === call.id);
		// 按调用顺序推进；只有当前位置开始、输出不重叠的相邻动作可一起执行，不能越过前面的串行动作。
		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index] as ActionRecord;
			const group: ActionRecord[] = [];
			const outputs = new Set<string>();
			for (let next = index; next < actions.length; next += 1) {
				const candidate = actions[next] as ActionRecord;
				const tool = options.tools.find((item) => item.name === candidate.call.name);
				const pending = candidate.state === "planned" || candidate.state === "effect_pending";
				if (!pending || !tool?.parallel || !Value.Check(tool.parameters, candidate.call.arguments)) break;
				const claimed = await tool.parallel(candidate.call.arguments);
				if (claimed === false || claimed.some((output) => outputs.has(output))) break;
				for (const output of claimed) outputs.add(output);
				group.push(candidate);
			}
			if (group.length > 1) {
				check();
				const settled = await Promise.allSettled(group.map((item) => settle(item, call)));
				const failed = settled.find((outcome) => outcome.status === "rejected");
				if (failed) throw failed.reason;
			}
			check();
			if (action.state === "delivered") {
				if (action.result?.terminate) {
					const result = await finishTerminated();
					if (result) return result;
					continue mainLoop;
				}
				continue;
			}
			if (action.state === "planned" || action.state === "effect_pending") await settle(action, call);
			if (!action.message || !action.result)
				throw new SuimingHarnessError("checkpoint_invalid", `动作 ${action.id} 没有结果`);
			options.onToolCall?.({
				actionId: action.id,
				toolCallId: action.call.id,
				toolName: action.call.name,
				args: action.call.arguments,
				isError: action.message.isError,
				summary: summarize(action.result),
			});
			state.messages.push(action.message);
			if (action.result.contextBoundary) state.boundary = state.messages.length;
			action.state = "delivered";
			const fingerprint = createHash("sha256")
				.update(JSON.stringify([action.call.name, action.call.arguments, action.message.content]))
				.digest("hex");
			state.repeated = {
				fingerprint,
				count: state.repeated?.fingerprint === fingerprint ? state.repeated.count + 1 : 1,
			};
			await save();
			if (action.result.terminate) {
				const result = await finishTerminated();
				if (result) return result;
				continue mainLoop;
			}
		}
		if (actions.length > 0 && actions.every((action) => action.message?.isError)) {
			state.rejectedStreak = (state.rejectedStreak ?? 0) + 1;
		} else if (actions.length > 0) delete state.rejectedStreak;
		const steeringCount = await pullSteering();
		if (actions.length === 0 && steeringCount === 0) {
			if (state.turns >= options.budget.maxTurns) return finish("budget_exhausted");
			const submissions = options.tools.filter((tool) => tool.submission).map((tool) => tool.name);
			if (!submissions.length) return finish("model_stopped");
			state.unsubmittedStops = (state.unsubmittedStops ?? 0) + 1;
			if (state.unsubmittedStops >= 3) return finish("model_stopped");
			state.messages.push({
				role: "user",
				content: `执行协议提醒：你的回复已保存，但当前任务尚未交付。若作者目标已完成，请调用 ${submissions.join(" / ")} 交付；若尚未完成，继续所需工作。不要仅为结束而提交未满足要求的结果。`,
				timestamp: Date.now(),
			});
		} else if (actions.some((action) => !action.message?.isError) || steeringCount > 0) {
			delete state.unsubmittedStops;
		}
		const reduced = actions.findLast((action) => action.result?.contextSummary);
		if (reduced?.result?.contextSummary)
			state.reduction = {
				throughMessage: Math.max(
					1,
					state.messages.findLastIndex((message) => message.role === "assistant"),
				),
				summary: reduced.result.contextSummary,
				actionId: reduced.id,
				modelCallId: call.id,
				...(reduced.result.contextOpening === undefined ? {} : { opening: reduced.result.contextOpening }),
			};
		state.phase = "ready";
		await save();
		if ((state.repeated?.count ?? 0) >= NO_PROGRESS_REPEATS)
			throw new SuimingHarnessError(
				"run_no_progress",
				`连续 ${NO_PROGRESS_REPEATS} 次做同一个动作、得到同一个结果，已保留进度。请补充方向后继续。`,
			);
		if ((state.rejectedStreak ?? 0) >= NO_PROGRESS_STREAK)
			throw new SuimingHarnessError(
				"run_no_progress",
				`连续 ${NO_PROGRESS_STREAK} 次回复里的动作都被拒绝，已保留进度。请补充方向后继续。`,
			);
	}
}
