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
	/** 最近一次压缩：摘要就在写它的那次回复的 compact_context 调用里；throughMessage 是那一批结果之后的下标。 */
	reduction?: {
		throughMessage: number;
		actionId: string;
		modelCallId: string;
		/** 压缩那一刻的开场快照，请求里替换第一条消息（只有根 Agent 有：它的开场是作品快照，子任务的开场是任务本身）。 */
		opening?: string;
	};
	/** 消息下标小于它的工具结果在请求里换成占位；原消息不改。只往前推，前缀因此在两次清理之间稳定。 */
	cleared?: number;
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
	onTurnStart?(turn: number, context: Context): Promise<void> | void;
	onTextDelta?(delta: string, callId: string): void;
	onMessage?(callId: string, message: AssistantMessage): void;
	onToolCall?(event: TaskLoopToolCallEvent): void;
	onModelCall?(usage: ModelUsage, callId: string, cumulative: ModelUsage): void;
	steering?(): Promise<{ sequence: number; text: string }[]> | { sequence: number; text: string }[];
	onSteer?(text: string, sequence: number): void;
	/** 作者消息进消息列表前的确定性附注（head、候选状态）；只改进模型看到的文本，事件里仍是原话。 */
	decorateSteering?(text: string, sequence: number): string | Promise<string>;
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

/**
 * 上下文的生命周期（2026-10-01 Harness 审查 F3）。会话永续，消息列表只增不减，请求必须有办法变小：
 * 先清掉较早的工具结果（确定、可恢复：原文还在作品或 checkpoint 里，要用就重读），清完仍偏大就请模型
 * 用 compact_context 压成摘要，实在放不下就如实报错。只改请求的投影，消息列表与 checkpoint 一字不改。
 * 比例是相对模型目录里的 contextWindow 的估计；估错了由 provider 的超限报错兜住（清理后重试一次）。
 */
const CLEAR_AT = 0.8;
const CLEAR_TO = 0.5;
const COMPACT_AT = 0.7;
/**
 * 刚过边界（新一轮或刚提交，之后模型还没回复过）时请模型压缩的门槛。手上没有做到一半的事，压掉的不会是正在用的，
 * 所以比中途的 COMPACT_AT 低：趁边界先压，免得做到一半撞上 70%（Harness 设计第 7 节「压缩在边界做」）。
 */
const BOUNDARY_COMPACT_AT = 0.5;
/** 压缩至少要能腾出这么多窗口才值得请模型做；压不动的开场消息不能让每次请求都要求压缩。 */
const COMPACT_MIN_GAIN = 0.1;
/** 估计值超过整个窗口才不发：差一点的照发，真超了由 provider 的报错兜住。 */
const GIVE_UP_AT = 1;
/**
 * 子任务的第一次请求估计超过窗口的这个比例就不发，作为委派失败交回父 Agent（`delegation_too_large`）。
 * 开场消息是父 Agent 给的输入，压缩压不动它；开场就过了压缩线，留给读写的只到清理线（0.8）前那一成。
 * 取压缩线是按两次真实运行定的：2026-10-04 三国补全的开场超过七成，五个子任务空转 19 分钟、估算 $92；
 * 10-03 斗破 120 章的 Source 审稿每次请求平均占 68%（含读取）照常做完。
 */
export const TASK_OPENING_AT = COMPACT_AT;
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

function clearedToolResult(message: ToolResultMessage): ToolResultMessage {
	const { details: _details, ...rest } = message;
	const length = Array.from(textOf(message)).length;
	return {
		...rest,
		content: [
			{
				type: "text",
				text: `[较早的工具结果已清除以腾出上下文：${message.toolName}，原文约 ${length} 字；需要时重新读取]`,
			},
		],
	};
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

/** 一条工具结果在请求里的样子：清理点之前换成占位，边界之前的大读取结果折成头尾，其余原样。 */
function projectToolResult(state: LoopCheckpoint, index: number, foldable: ReadonlySet<string>): ToolResultMessage {
	const message = state.messages[index] as ToolResultMessage;
	if (index < (state.cleared ?? 0)) return clearedToolResult(message);
	if (
		index < (state.boundary ?? 0) &&
		foldable.has(message.toolName) &&
		Buffer.byteLength(textOf(message)) > FOLD_BYTES
	)
		return foldedToolResult(state.messages, index, message);
	return message;
}

/**
 * 发给模型的消息：工具结果按清理点与边界投影（projectToolResult）；压缩过的话，写摘要的那次回复之前只留作者消息，
 * 其余由那次回复里 compact_context 的 summary 代表。那次回复本身和它同一批的结果照常发：模型常把压缩和别的
 * 工具放在同一次回复里，2026-10-05 之前压缩点划在整批之后，同一批里读到的东西被摘要一起盖掉，而摘要写在读之前。
 */
function projectMessages(state: LoopCheckpoint, foldable: ReadonlySet<string>): Message[] {
	const project = (message: Message, index: number): Message =>
		message.role === "toolResult" ? projectToolResult(state, index, foldable) : message;
	if (!state.reduction) return state.messages.map(project);
	let response = state.reduction.throughMessage - 1;
	while (response > 0 && state.messages[response]?.role !== "assistant") response -= 1;
	const opening = state.reduction.opening;
	return [
		...state.messages
			.slice(0, response)
			.flatMap((message, index): Message[] =>
				message.role !== "user"
					? []
					: index === 0 && opening !== undefined
						? [{ ...message, content: opening }]
						: [message],
			),
		...state.messages.slice(response).map((message, offset) => project(message, response + offset)),
	];
}

function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/** 最近一次正常返回的请求：input tokens / 请求字节数。 */
function tokensPerByte(state: LoopCheckpoint): number {
	for (let index = state.calls.length - 1; index >= 0; index -= 1) {
		const call = state.calls[index];
		if (call?.state !== "received" || !call.usage || !call.promptBytes) continue;
		const prompt = call.usage.input + call.usage.cacheRead + call.usage.cacheWrite;
		if (prompt > 0) return prompt / call.promptBytes;
	}
	return DEFAULT_TOKENS_PER_BYTE;
}

/** 清理点最远推到最后一条模型回复：它之后的工具结果是模型下一步要用的，不能清。 */
function clearableUntil(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1)
		if (messages[index]?.role === "assistant") return index;
	return 0;
}

function contextOverflowError(): SuimingHarnessError {
	return new SuimingHarnessError(
		"context_overflow",
		"对话超出了模型的上下文上限，清掉较早的工具结果后仍然放不下。请开一个新对话接着做（作品和已提交的版本都在），或换一个上下文更大的模型。",
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
		state.messages.pop();
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
						`开场输入约 ${Math.round((promptBytes * ratio) / 1000)}k token，占 ${options.model.model.id} 窗口的 ${Math.round(((promptBytes * ratio) / window) * 100)}%（上限 ${Math.round(options.openingLimit * 100)}%），子任务放不下、也没有读写的余地，一次请求都没发。把范围拆小再派（比如按卷）；拆不小就停下告诉作者。`,
					);
				if (promptBytes * ratio > window * CLEAR_AT) {
					// 从旧到新清，清到估计值落到 CLEAR_TO 以下或清到最后一条模型回复为止。
					const until = clearableUntil(state.messages);
					let saved = 0;
					let cleared = Math.max(state.cleared ?? 0, state.reduction?.throughMessage ?? 0);
					while (cleared < until && (promptBytes - saved) * ratio > window * CLEAR_TO) {
						const message = state.messages[cleared];
						if (message?.role === "toolResult")
							saved +=
								bytesOf(projectToolResult(state, cleared, foldable)) - bytesOf(clearedToolResult(message));
						cleared += 1;
					}
					if (cleared > (state.cleared ?? 0)) {
						state.cleared = cleared;
						context = build();
						promptBytes = bytesOf(context);
					}
				}
				if (promptBytes * ratio > window * GIVE_UP_AT) throw contextOverflowError();
				// 压缩只压得动模型回复与工具结果，作者消息原样保留：可压的部分不到窗口的一成就不再要求，
				// 否则开场消息本身就超线时，每次请求都要求压缩，模型每次照做，永远不往下干活。
				const compactable = projectMessages(state, foldable)
					.filter((message) => message.role !== "user")
					.reduce((sum, message) => sum + bytesOf(message), 0);
				const atBoundary =
					state.boundary !== undefined &&
					!state.messages.slice(state.boundary).some((message) => message.role === "assistant");
				if (
					promptBytes * ratio > window * (atBoundary ? BOUNDARY_COMPACT_AT : COMPACT_AT) &&
					compactable * ratio > window * COMPACT_MIN_GAIN &&
					declarations.some((tool) => tool.name === "compact_context")
				) {
					// 只加在这次请求的末尾，不进消息列表：前缀不变，压缩之后自然消失。
					const used = Math.round(((promptBytes * ratio) / window) * 100);
					context.messages.push({
						role: "user",
						content: atBoundary
							? `[系统附注：上下文已用到窗口的约 ${used}%。上一件事已经做完，趁现在先调用 compact_context 把之前的过程压成摘要（保留作者要求、未完成的计划、结果引用与待验证的判断），再处理接下来的事。]`
							: `[系统附注：上下文已用到窗口的约 ${used}%，清掉较早的工具结果后仍偏大。先调用 compact_context 把已处理的过程压成摘要（保留作者要求、未完成的计划、结果引用与待验证的判断），再继续。]`,
						timestamp: Date.now(),
					});
					promptBytes = bytesOf(context);
				}
			}
			state.turns += 1;
			await options.onTurnStart?.(state.turns, context);
			check();
			state.calls.push({ id: `call_${randomUUID()}`, turn: state.turns, state: "prepared", promptBytes });
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
					signal: abort.signal,
					...(options.loopId === undefined ? {} : { sessionId: options.loopId }),
					...(options.telemetryContext === undefined ? {} : { telemetryContext: options.telemetryContext }),
				});
				for await (const event of stream) {
					if (event.type === "text_delta" && event.delta) options.onTextDelta?.(event.delta, call.id);
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
			state.messages.push(response);
			state.actions.push(
				...response.content
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
		options.onMessage?.(call.id, call.response);
		if (!call.usageRecorded) {
			options.onModelCall?.(call.usage, call.id, state.usage);
			call.usageRecorded = true;
			await save();
		}
		check();
		if (call.response.stopReason === "aborted") throw interruptedError(options.signal);
		if (
			(call.response.stopReason === "error" || call.response.stopReason === "length") &&
			isContextOverflow(call.response, options.model.model.contextWindow || undefined)
		) {
			// provider 说放不下：撤回这次响应，把能清的工具结果全清掉再试一次。清无可清或已经试过就如实报错，
			// 否则下一句会把同一份上下文原样再发，会话卡死在同一个错误上。
			const until = clearableUntil(state.messages.slice(0, -1));
			if (state.overflowRetried || until <= (state.cleared ?? 0)) throw contextOverflowError();
			state.overflowRetried = true;
			state.messages.pop();
			state.actions = state.actions.filter((action) => action.modelCallId !== call.id);
			state.cleared = until;
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
				state.messages.pop();
				state.actions = state.actions.filter((action) => action.modelCallId !== call.id);
				state.phase = "ready";
				await save();
				try {
					await sleep(Math.min(policy.baseDelayMs * 2 ** retries, TRANSIENT_RETRY.maxDelayMs), undefined, {
						...(options.signal === undefined ? {} : { signal: options.signal }),
					});
				} catch {
					throw interruptedError(options.signal);
				}
				continue;
			}
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
		// 相邻的可并行动作先一起推进到 result_ready，下面的循环再按派出顺序交付。一个出了基础设施故障，
		// 等同组的都停下再抛第一个——作者打断时整组共用同一个 signal，一起停。
		for (let index = 0; index < actions.length; ) {
			const group: ActionRecord[] = [];
			while (index < actions.length) {
				const action = actions[index] as ActionRecord;
				const tool = options.tools.find((item) => item.name === action.call.name);
				const pending = action.state === "planned" || action.state === "effect_pending";
				if (!pending || !tool?.parallel || !Value.Check(tool.parameters, action.call.arguments)) break;
				if (!(await tool.parallel(action.call.arguments))) break;
				group.push(action);
				index += 1;
			}
			if (group.length === 0) index += 1;
			if (group.length < 2) continue;
			check();
			const settled = await Promise.allSettled(group.map((action) => settle(action, call)));
			const failed = settled.find((outcome) => outcome.status === "rejected");
			if (failed) throw failed.reason;
		}
		for (const action of actions) {
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
				throughMessage: state.messages.length,
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
