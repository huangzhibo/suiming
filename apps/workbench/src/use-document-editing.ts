import { type RefObject, useEffect, useRef, useState } from "react";
import { invoke } from "./bridge.js";
import { CommandError } from "./command-error.js";
import type { useCurrentDocument } from "./use-current-document.js";
import type { useWorkspaceGroup } from "./use-workspace-group.js";
import { savedDocument } from "./view-state.js";
import { useWorkspace } from "./workspace-context.js";

/** 每个文档窗格的编辑事务与反馈。复用共享草稿和 CAS；异步回包不能抢走另一个文档的焦点。 */
export function useDocumentEditing(
	workspace: Pick<
		ReturnType<typeof useWorkspaceGroup>,
		"group" | "setView" | "live" | "layoutLive" | "patch" | "queryClient" | "shown" | "refresh"
	>,
	current: ReturnType<typeof useCurrentDocument>,
	mainRef: RefObject<HTMLElement | null>,
) {
	const { group, setView, live, layoutLive, patch, queryClient, shown, refresh } = workspace;
	const {
		tab,
		editPath,
		editFile,
		buffer,
		missingFile,
		conflict,
		setBuffer,
		file,
		changed,
		kind,
		fileDiagnostic,
		primary,
	} = current;
	const { busy, setBusy, setError, notice, setNotice } = useWorkspace();
	const [statusOpen, setStatusOpen] = useState(false);
	const [saveError, setSaveError] = useState("");
	const statusRef = useRef<HTMLDivElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const documentKey = `${tab?.id}:${editPath}`;
	const latestDocumentKey = useRef(documentKey);
	latestDocumentKey.current = documentKey;
	// biome-ignore lint/correctness/useExhaustiveDependencies: 换文档时关闭上一个文档的临时处理入口
	useEffect(() => {
		setStatusOpen(false);
		setSaveError("");
	}, [tab?.id, editPath]);
	const focusEditor = () =>
		mainRef.current?.querySelector<HTMLElement>(
			'.cm-merge-b [contenteditable="true"], .cm-editor [contenteditable="true"]',
		) ?? null;
	const showStatus = () => {
		returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setStatusOpen(true);
	};

	const rebase = () => {
		if (!editFile) return;
		setView((v) => ({
			...v,
			documents: {
				...v.documents,
				[editPath]: { content: buffer, baseContent: editFile.content, baseSHA: editFile.sha256 },
			},
		}));
		setSaveError("");
		setStatusOpen(false);
		setError("");
		setNotice("外部版本已设为基线；编辑内容仍保留，请完成合并后保存。");
	};
	async function savePath(path: string, restoreMissing = false) {
		const draft = live.current.documents[path];
		if (!draft) return;
		const args = {
			path,
			content: draft.content,
			expectedSHA: restoreMissing ? null : draft.baseSHA,
			...(shown?.projectId ? { expectedProjectId: shown.projectId } : {}),
		};
		const result = await invoke("workspace.file.save", args);
		setView((v) => savedDocument(v, path, result.content, result.sha256, draft));
		await queryClient.invalidateQueries({ queryKey: ["file", shown?.projectId, path] });
		setError("");
		setNotice("已保存");
	}
	// 文档保存错误由本文件的处理入口负责，不再写入全局提示造成重复。
	const save = async (restoreMissing = false) => {
		if (busy) return;
		if (!restoreMissing && (missingFile || conflict !== undefined)) {
			showStatus();
			return;
		}
		const savingDocument = documentKey;
		const origin = document.activeElement;
		setBusy(true);
		setSaveError("");
		try {
			await savePath(editPath, restoreMissing);
			refresh();
			if (latestDocumentKey.current !== savingDocument) return;
			setStatusOpen(false);
			if (
				layoutLive.current.activeGroup === group &&
				(document.activeElement === origin ||
					document.activeElement === document.body ||
					statusRef.current?.contains(document.activeElement))
			) {
				focusEditor()?.focus();
			}
		} catch (failure) {
			await queryClient.invalidateQueries({ queryKey: ["file", shown?.projectId, editPath] });
			if (latestDocumentKey.current !== savingDocument) return;
			if (!(failure instanceof CommandError && failure.code === "checkout_edit_conflict"))
				setSaveError(failure instanceof Error ? failure.message : String(failure));
			showStatus();
		} finally {
			setBusy(false);
		}
	};
	const updateBuffer = (content: string) => {
		setBuffer(content);
		if (notice === "已保存") setNotice("");
	};
	const beginEdit = (path: string) =>
		patch({
			targetPath: path,
			edit: "edit",
		});
	// 页面对象消失时，原编辑目标（可能是正文）仍由草稿持有；切阅读不能把它换成缺失的设计路径。
	const finishTask = () => patch({ edit: "read", targetPath: !file && changed ? editPath : "" });

	const documentProblem =
		missingFile && changed
			? "文件已移除"
			: conflict !== undefined
				? "外部修改冲突"
				: saveError
					? "保存失败"
					: kind === "artifact" && fileDiagnostic
						? "文件格式有误"
						: kind === "artifact" && primary.error && file
							? "文件读取失败"
							: "";
	useEffect(() => {
		if (!documentProblem) setStatusOpen(false);
	}, [documentProblem]);

	const changeStatusOpen = (on: boolean, reason: string) => {
		if (!on && (reason === "outside-press" || reason === "focus-out")) returnFocus.current = null;
		if (on)
			returnFocus.current =
				focusEditor() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		setStatusOpen(on);
	};
	const statusFinalFocus = () => {
		if (layoutLive.current.activeGroup !== group || latestDocumentKey.current !== documentKey) return false;
		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			active !== document.body &&
			active !== returnFocus.current &&
			!statusRef.current?.contains(active) &&
			active.getAttribute("aria-label") !== documentProblem
		)
			return false;
		return returnFocus.current?.isConnected ? returnFocus.current : false;
	};

	return {
		statusOpen,
		saveError,
		setSaveError,
		statusRef,
		changeStatusOpen,
		statusFinalFocus,
		rebase,
		savePath,
		save,
		updateBuffer,
		beginEdit,
		finishTask,
		documentProblem,
	};
}
