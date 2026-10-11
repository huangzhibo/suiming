import type { ModelChoice } from "@suiming/sdk";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "./bridge.js";
import { CommandError } from "./command-error.js";
import { type ComposerDraft, type ComposerSubmission, rejectSubmission, stageSubmission } from "./composer-state.js";

export interface ComposerSubmitBinding {
	composer: ComposerDraft;
	draftKey: string;
	session: { id: string; status: string; model?: ModelChoice } | undefined;
	updateComposer(key: string, update: (draft: ComposerDraft) => ComposerDraft, persist?: boolean): void;
	onSubmitted(key: string, id: string, sessionId: string): void;
	refresh(): void;
	isCurrentProject(): boolean;
}

/**
 * 对话的唯一发送路径：先把冻结内容和命令 ID 写入本地工作现场，再发 IPC；回包丢失时重载后由作者显式确认，
 * 重试沿用同一命令 ID。输入框与正文选段栏的就地修改都走这里——两处各写一份时，就地发送会绕过冻结与重试。
 * `submit(retry)` 发输入框当前的草稿；`submitDraft(draft)` 发一份另行组好的草稿（只在输入框为空时用，
 * 否则会顶掉作者没发出的内容）。
 */
export function useComposerSubmit({
	composer,
	draftKey,
	session,
	updateComposer,
	onSubmitted,
	refresh,
	isCurrentProject,
}: ComposerSubmitBinding) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const inFlight = useRef(false);
	const latest = useRef(composer);
	latest.current = composer;
	const update = (change: (draft: ComposerDraft) => ComposerDraft, persist = false) =>
		updateComposer(draftKey, change, persist);

	async function send(retry?: ComposerSubmission, draft?: ComposerDraft) {
		if (inFlight.current || !isCurrentProject()) return;
		const original = draft ?? latest.current;
		const staged = retry ? latest.current : stageSubmission(original, session);
		const pending = retry ?? staged.pending;
		if (!pending || (!retry && latest.current.pending)) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		let stagedLocally = false;
		const changePending = (change: Partial<ComposerSubmission>) =>
			update(
				(current) =>
					current.pending?.id === pending.id
						? { ...current, pending: { ...current.pending, ...change } }
						: current,
				true,
			);
		try {
			flushSync(() => (retry ? changePending({ error: "" }) : update(() => staged, true)));
			stagedLocally = true;
			const receipt = await invoke("session.send", {
				commandId: pending.id,
				text: pending.text,
				...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
				...(pending.model ? { model: pending.model } : {}),
			});
			onSubmitted(draftKey, pending.id, receipt.sessionId);
			refresh();
		} catch (reason) {
			const message = reason instanceof Error ? reason.message : String(reason);
			try {
				// 这些错误只来自 LocalWorkspace 的模型预检，发生在建 session / 入 inbox 之前。
				// 重试可能是在取一条已接收消息的回执，不能仅凭这次预检失败就断言此前没发送。
				const rejected =
					!retry &&
					reason instanceof CommandError &&
					[
						"model_config_not_found",
						"missing_model_config",
						"invalid_model_config",
						"invalid_model_config_file",
						"invalid_model_options",
						"model_provider_disabled",
						"model_not_found",
						"model_credentials_missing",
					].includes(reason.code);
				if (!stagedLocally) setError(message);
				else if (rejected) {
					update((current) => rejectSubmission(current, pending.id, original), true);
					setError(`未发送，内容已退回草稿。${message}`);
				} else changePending({ error: message });
			} catch {
				setError(message);
			}
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}

	return {
		busy,
		setBusy,
		error,
		setError,
		submit: (retry?: ComposerSubmission) => send(retry),
		submitDraft: (draft: ComposerDraft) => send(undefined, draft),
	};
}
