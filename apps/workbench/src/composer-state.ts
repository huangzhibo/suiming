import type { ModelChoice } from "@suiming/sdk";

export interface ComposerDraft {
	model?: ModelChoice;
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
	if (draft.goal || draft.attachments.length || draft.pending || draft.model) composerDrafts[key] = draft;
	else delete composerDrafts[key];
	// 开始输入即选定当前对话，重载不能因后台新出现 session 而切走这份草稿。
	return { ...state, composerDrafts, sessionChosen: true };
}
export function stageSubmission(
	draft: ComposerDraft,
	session?: { id: string; status: string; model?: ModelChoice },
): ComposerDraft {
	if (
		draft.pending ||
		draft.attachments.some((item) => item.status !== "ready") ||
		composerReferenceBytes(draft) > MAX_INPUT_BYTES
	)
		return draft;
	const text = composerText(draft);
	if (!text) return draft;
	// 换模型只在 turn 边界生效：正在跑的 session 这次不带模型，输入框里的选择留到下一轮。
	const model = draft.model && session?.status !== "running" ? draft.model : undefined;
	return {
		...emptyComposer(),
		...(draft.model ? { model: draft.model } : {}),
		pending: {
			id: crypto.randomUUID(),
			text,
			...(model ? { model } : {}),
			...(session ? { sessionId: session.id } : {}),
		},
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

/** 本机草稿恢复：字段逐个校验，不认识的丢掉；输入只有 attachments 一种表示。 */
export function restoreComposerDrafts(value: unknown): Record<string, ComposerDraft> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, value]) => {
			if (!value || typeof value !== "object") return [];
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
			return [
				[
					key,
					{
						goal: typeof saved.goal === "string" ? saved.goal : "",
						attachments,
						...(validModelChoice(saved.model) ? { model: saved.model } : {}),
						...(pending && typeof pending.id === "string" && typeof pending.text === "string"
							? {
									pending: {
										id: pending.id,
										text: pending.text,
										...(typeof pending.sessionId === "string" ? { sessionId: pending.sessionId } : {}),
										...(validModelChoice(pending.model) ? { model: pending.model } : {}),
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
