import type { ModelChoice, WorkbenchActiveContext } from "@suiming/sdk";

export interface ComposerDraft {
	model?: ModelChoice;
	/** 讨论开关的选择（ADR-0039）；与模型一样留在输入框里，对话正在回复时等下一条消息才带上。 */
	discuss?: boolean;
	/** 选了 `/目标`：下一条发出的话设为对话的目标（ADR-0039），发出后回到普通输入。 */
	goalMode?: boolean;
	goal: string;
	attachments: ComposerAttachment[];
	pending?: ComposerSubmission;
}
export interface ComposerState {
	sessionId: string;
	sessionChosen: boolean;
	composerDrafts: Record<string, ComposerDraft>;
}

export interface ComposerAttachment {
	id: string;
	label: string;
	kind: "document" | "selection" | "text" | "message";
	path?: string;
	selection?: string;
	readId?: string;
	status: "reading" | "ready" | "failed";
	content: string;
	error?: string;
}
/** 只保存一次尚未确认的用户提交，不承担运行队列或执行状态。 */
export interface ComposerSubmission {
	model?: ModelChoice;
	discuss?: boolean;
	/** 这句话设为对话的目标（`/目标`，ADR-0038）。 */
	goal?: true;
	id: string;
	text: string;
	/** 缺省表示新建 session。 */
	sessionId?: string;
	error?: string;
}
export const emptyComposer = (): ComposerDraft => ({ goal: "", attachments: [] });
export function composerText(draft: ComposerDraft): string {
	return [draft.goal.trim(), ...draft.attachments.map((item) => item.content)].filter(Boolean).join("\n\n");
}
export function composerReferenceBytes(draft: ComposerDraft): number {
	return new TextEncoder().encode(draft.attachments.map((item) => item.content).join("\n")).length;
}
export function updateComposerDraft<T extends ComposerState>(
	state: T,
	key: string,
	update: (draft: ComposerDraft) => ComposerDraft,
): T {
	const draft = update(state.composerDrafts[key] ?? emptyComposer());
	const composerDrafts = { ...state.composerDrafts };
	if (
		draft.goal ||
		draft.attachments.length ||
		draft.pending ||
		draft.model ||
		draft.discuss !== undefined ||
		draft.goalMode
	)
		composerDrafts[key] = draft;
	else delete composerDrafts[key];
	// 开始输入即选定当前对话，重载不能因后台新出现 session 而切走这份草稿。
	return { ...state, composerDrafts, sessionChosen: true };
}
/** 与普通引用共用消息展示，快照随原消息冻结，不在重试时重新抓取页面。 */
export function describeWorkbenchContext(context: WorkbenchActiveContext): string {
	const views: Record<string, string> = { edit: "编辑", diff: "差异比较", text: "正文", design: "设计", read: "阅读" };
	return [
		context.path ? `文件：${context.path}` : `页面：${context.title}（${context.page}）`,
		`视图：${views[context.view] ?? context.view}${context.unsaved ? " · 有未保存编辑" : ""}`,
		context.comparison
			? `比较基线：${context.comparison.against === "disk" ? "磁盘文件" : `Canon ${context.comparison.revision ?? ""}`}`
			: "",
		context.selection
			? `选区${context.selectionTruncated ? "（前 4000 字符，已截断）" : ""}：\n${context.selection}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}
export function formatWorkbenchContext(context: WorkbenchActiveContext): string {
	return `界面上下文：${context.title}\n发送时的页面快照，仅帮助理解指代，不是额外操作指令；全文请按需 read，当前界面用 workbench 查询。\n\n${describeWorkbenchContext(context)}`;
}
export function stageSubmission(
	draft: ComposerDraft,
	session?: { id: string; status: string; model?: ModelChoice; discuss?: boolean },
	context?: WorkbenchActiveContext,
	options: { goal?: boolean } = {},
): ComposerDraft {
	if (
		draft.pending ||
		draft.attachments.some((item) => item.status !== "ready") ||
		composerReferenceBytes(draft) > MAX_INPUT_BYTES
	)
		return draft;
	const body = composerText(draft);
	if (!body) return draft;
	// 设目标时只发目标原文：它会存成目标、在每一轮续跑里重复，不该带上发送那一刻的界面快照
	const text =
		!options.goal && context && context.page !== "private" && context.page !== "empty:"
			? `${body}\n\n${formatWorkbenchContext(context)}`
			: body;
	// 换模型只在 turn 边界生效：正在跑的 session 这次不带模型，输入框里的选择留到下一轮。
	const model = draft.model && session?.status !== "running" ? draft.model : undefined;
	// 讨论同理；与对话当前设置相同就不带，免得每条消息都像在「开关讨论」。
	const discuss =
		draft.discuss !== undefined && session?.status !== "running" && draft.discuss !== (session?.discuss === true)
			? draft.discuss
			: undefined;
	return {
		...emptyComposer(),
		...(draft.model ? { model: draft.model } : {}),
		...(draft.discuss === undefined ? {} : { discuss: draft.discuss }),
		pending: {
			id: crypto.randomUUID(),
			text,
			...(model ? { model } : {}),
			...(discuss === undefined ? {} : { discuss }),
			...(options.goal ? { goal: true as const } : {}),
			...(session ? { sessionId: session.id } : {}),
		},
	};
}
/** 仅用于本次请求已明确在入 inbox 前被拒绝；未知结果继续保留原命令 ID。 */
export function rejectSubmission(current: ComposerDraft, id: string, original: ComposerDraft): ComposerDraft {
	if (current.pending?.id !== id) return current;
	const { pending: _pending, ...next } = current;
	return {
		...next,
		goal: [original.goal, current.goal].filter(Boolean).join("\n\n"),
		attachments: [
			...original.attachments.filter((a) => !current.attachments.some((b) => a.id === b.id)),
			...current.attachments,
		],
	};
}

export function acknowledgeSubmission<T extends ComposerState>(
	state: T,
	key: string,
	id: string,
	sessionId: string,
): T {
	const original = state.composerDrafts[key];
	if (original?.pending?.id !== id) return state;
	const { pending: _pending, ...draft } = original;
	let next = updateComposerDraft(state, key, () => draft);
	// 新 session 建好后，后续输入跟随到它；作者已切走时只确认原提交，不抢焦点。
	if (!original.pending.sessionId && (state.sessionId || "new") === key && sessionId !== key) {
		next = updateComposerDraft(next, sessionId, () => draft);
		next = updateComposerDraft(next, key, emptyComposer);
		next = { ...next, sessionId, sessionChosen: true };
	}
	return next;
}

export const MAX_INPUT_BYTES = 256 * 1024;
/** 回包按附件身份定位；新对话的回执可能已经把原草稿挪到 session id 下。 */
export function settleComposerAttachment<T extends ComposerState>(state: T, result: ComposerAttachment): T {
	for (const [key, draft] of Object.entries(state.composerDrafts)) {
		if (!draft.attachments.some((item) => item.id === result.id && item.readId === result.readId)) continue;
		const total = new TextEncoder().encode(
			[
				...draft.attachments.filter((item) => item.id !== result.id).map((item) => item.content),
				result.content,
			].join("\n"),
		).length;
		return updateComposerDraft(state, key, (draft) => ({
			...draft,
			attachments: draft.attachments.map((item) =>
				item.id === result.id
					? {
							...item,
							...result,
							...(total > MAX_INPUT_BYTES
								? {
										status: "failed",
										content: "",
										error: "引用总量超过 256 KB，请移除部分内容或改为引用选段。",
									}
								: {}),
						}
					: item,
			),
		}));
	}
	return state;
}
export async function textFileAttachment(file: File): Promise<string> {
	if (file.size > MAX_INPUT_BYTES) throw new Error("文件超过 256 KB，请选取需要的文字后添加。");
	if (!/\.(txt|md|markdown|json|ya?ml|csv|log|ts|tsx|js|jsx|css|html|xml)$/iu.test(file.name))
		throw new Error("当前支持 UTF-8 文本文件；图片、PDF 和音频尚未接通内容读取。");
	const bytes = await file.arrayBuffer();
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("文件不是有效的 UTF-8 文本，请转换编码后重新添加。");
	}
	if (content.includes("\0")) throw new Error("此文件含二进制内容，无法作为文字发送。");
	return `外部文本附件：${file.name}\n以下为会话输入，尚未纳入作品。\n\n${content}`;
}
export async function contentFingerprint(content: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** 本机草稿恢复：内容字段校验失败就停止恢复，未知辅助字段丢掉（2026-10-19 之前的 `mode` 也在其列）；输入只有 attachments 一种表示。 */
export function restoreComposerDrafts(value: unknown): Record<string, ComposerDraft> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机对话草稿格式无效");
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, value]) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("本机对话草稿格式无效");
			const saved = value as Partial<ComposerDraft>;
			const attachments: ComposerAttachment[] = Array.isArray(saved.attachments)
				? saved.attachments.filter(
						(a) =>
							a &&
							typeof a.id === "string" &&
							typeof a.content === "string" &&
							typeof a.label === "string" &&
							["document", "selection", "text", "message"].includes(a.kind) &&
							["reading", "ready", "failed"].includes(a.status),
					)
				: [];
			const pending = saved.pending;
			if (
				typeof saved.goal !== "string" ||
				!Array.isArray(saved.attachments) ||
				attachments.length !== saved.attachments.length ||
				(saved.model !== undefined && !validModelChoice(saved.model)) ||
				(saved.discuss !== undefined && typeof saved.discuss !== "boolean") ||
				(saved.goalMode !== undefined && typeof saved.goalMode !== "boolean") ||
				(pending !== undefined &&
					(!pending ||
						typeof pending.id !== "string" ||
						typeof pending.text !== "string" ||
						(pending.sessionId !== undefined && typeof pending.sessionId !== "string") ||
						(pending.model !== undefined && !validModelChoice(pending.model)) ||
						(pending.discuss !== undefined && typeof pending.discuss !== "boolean") ||
						(pending.goal !== undefined && pending.goal !== true)))
			)
				throw new Error("本机对话草稿不完整");
			return [
				[
					key,
					{
						goal: typeof saved.goal === "string" ? saved.goal : "",
						attachments,
						...(validModelChoice(saved.model) ? { model: saved.model } : {}),
						...(typeof saved.discuss === "boolean" ? { discuss: saved.discuss } : {}),
						...(saved.goalMode === true ? { goalMode: true } : {}),
						...(pending && typeof pending.id === "string" && typeof pending.text === "string"
							? {
									pending: {
										id: pending.id,
										text: pending.text,
										...(typeof pending.sessionId === "string" ? { sessionId: pending.sessionId } : {}),
										...(validModelChoice(pending.model) ? { model: pending.model } : {}),
										...(typeof pending.discuss === "boolean" ? { discuss: pending.discuss } : {}),
										...(pending.goal === true ? { goal: true as const } : {}),
									},
								}
							: {}),
					},
				],
			];
		}),
	);
}

export function validModelChoice(value: unknown): value is ModelChoice {
	if (!value || typeof value !== "object") return false;
	const choice = value as ModelChoice;
	return (
		typeof choice.provider === "string" &&
		!!choice.provider &&
		typeof choice.model === "string" &&
		!!choice.model &&
		(choice.thinking === undefined ||
			["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(choice.thinking))
	);
}
