import type { JsonValue, Static, Tool, ToolResultMessage, TSchema } from "@earendil-works/pi-ai";
import { formatDiagnostic, SuimError } from "@suiming/story";

/** 工具结果的 details 随 ToolResultMessage 进 checkpoint 与 pi-ai，必须是 JSON 值（pi-ai 0.99 起类型上要求）。 */
export type ToolDetails = JsonValue | undefined;

/** 模型可见声明复用 pi-ai；执行和恢复策略由 Suiming 拥有。 */
export interface HarnessTool<TParameters extends TSchema = TSchema, TDetails extends ToolDetails = ToolDetails>
	extends Tool<TParameters> {
	label?: string;
	/** 此工具校验并交付 Task；自然语言停下不能替代它。 */
	submission?: boolean;
	/**
	 * 进程在动作 effect_pending 时退出后如何收口：read 复用 prepare 的结果，reconcile 由工具自己核对，
	 * never 表示不可重放。必填——漏写会让恢复落到 action_effect_unknown，session 每次续跑都在同一点暂停。
	 */
	replay: "read" | "reconcile" | "never";
	/**
	 * 同一次模型回复里相邻的、都判为可并行的动作同时执行，结果仍按派出顺序交付。只给输出互不重叠、
	 * 也不读彼此产物的动作（各读一段原文、各写各的笔记）；同一文件被两个动作写，第二次落盘时由 journal 报冲突。
	 */
	parallel?(params: Static<TParameters>): boolean;
	prepare?(params: Static<TParameters>, signal?: AbortSignal): Promise<unknown>;
	execute(
		actionId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: (result: HarnessToolResult<TDetails>) => void,
		prepared?: unknown,
	): Promise<HarnessToolResult<TDetails>>;
	reconcile?(
		actionId: string,
		params: Static<TParameters>,
		prepared: unknown,
		signal?: AbortSignal,
	): Promise<HarnessToolResult<TDetails>>;
}

export interface HarnessToolResult<TDetails extends ToolDetails = ToolDetails> {
	content: ToolResultMessage["content"];
	details?: TDetails;
	terminate?: boolean;
	/** 已由当前模型生成的运行摘要；只裁剪后续输入，原消息和动作保留。 */
	contextSummary?: string;
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
