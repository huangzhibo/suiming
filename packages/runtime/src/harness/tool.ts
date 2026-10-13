import type { JsonValue, Static, Tool, ToolResultMessage, TSchema } from "@earendil-works/pi-ai";
import { formatDiagnostic, SuimError } from "@suiming/story";

/** 工具结果的 details 随 ToolResultMessage 进 checkpoint 与 pi-ai，必须是 JSON 值（pi-ai 0.99 起类型上要求）。 */
export type ToolDetails = JsonValue | undefined;

/** 模型可见声明复用 pi-ai；执行由 Suiming 拥有。 */
export interface HarnessTool<TParameters extends TSchema = TSchema, TDetails extends ToolDetails = ToolDetails>
	extends Tool<TParameters> {
	/** 此工具校验并交付 Task；自然语言停下不能替代它。 */
	submission?: boolean;
	/**
	 * 同样的参数再调一次就能拿回（当前的）结果：只读，不依赖外部时刻。边界折叠只折这类工具的大结果
	 * （loop 的 FOLD_BYTES）；调研的 fetch 拿不回同样的东西，不标。
	 */
	rereadable?: boolean;
	/**
	 * false 表示串行；数组列出这次动作独占的输出标识。相邻动作的标识没有交集才并行，结果按派出顺序交付。
	 * 空数组只用于只读或输出已按动作隔离的任务。它不是依赖图，也不跨模型回复调度。
	 */
	parallel?(params: Static<TParameters>): false | readonly string[] | Promise<false | readonly string[]>;
	execute(actionId: string, params: Static<TParameters>, signal?: AbortSignal): Promise<HarnessToolResult<TDetails>>;
	/**
	 * 动作执行到一半被打断（作者停止、应用退出、进程中断）后，loop 给模型补一条「被打断」的结果，不重做、不核对；
	 * 工具可以在后面补一句模型做决定用得上的事实，比如子任务做到哪、提交成了哪个版本。只读，不产生副作用。
	 */
	interrupted?(actionId: string, params: Static<TParameters>): Promise<string | undefined>;
}

export interface HarnessToolResult<TDetails extends ToolDetails = ToolDetails> {
	content: ToolResultMessage["content"];
	details?: TDetails;
	terminate?: boolean;
	/** 已由当前模型生成的运行摘要；只裁剪后续输入，原消息和动作保留。 */
	contextSummary?: string;
	/** 压缩那一刻的开场快照：之后的请求里替换第一条消息（根 Agent 的会话开场快照会过时）。 */
	contextOpening?: string;
	/** 这个结果是上下文的边界（提交产生了新版本）：它之前的大读取结果，之后的请求里折叠成头尾。 */
	contextBoundary?: boolean;
}

/** 可由模型修复的参数、权限或领域拒绝；基础设施错误停止执行。 */
export class ToolRejection extends Error {
	constructor(
		readonly code: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(`${code}: ${message}`, options);
		this.name = "ToolRejection";
	}
}

/**
 * loop 收工具异常时先过这一道：packages/story 的诊断（`SuimError` 及其子类 `StoryParseError`）说的都是作品内容哪里
 * 不对，模型改得了，一律作为工具失败回到模型手里，带上 formatDiagnostic 的 expected / received / hint。其余原样返回，
 * 由 loop 照旧往上抛。2026-10-02 之前靠每个工具自己记得转，read_source 与 source_coverage 漏了，斗破抽取时 Design
 * 里一处写错就掀掉了 35 分钟的根 turn。领域 `ArtifactError` 不在这里转：其中有 `session_owner_lost` 这类执行状态故障，
 * 哪些能交给模型要由工具自己判断。
 */
export function rejectionForToolError(error: unknown): unknown {
	if (!(error instanceof SuimError)) return error;
	const detail = error.diagnostics.map(formatDiagnostic).join("\n");
	return new ToolRejection(error.code, detail.length === 0 ? error.message : `${error.message}\n${detail}`, {
		cause: error,
	});
}
