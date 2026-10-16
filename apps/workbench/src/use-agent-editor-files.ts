import type { EditorFileCall, EditorFileReply, EditorFileSnapshot } from "@suiming/sdk";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { bridge, invoke } from "./bridge.js";
import { contentFingerprint } from "./composer-state.js";
import { matchingDocumentPath } from "./document-navigation.js";
import type { useWorkspaceData } from "./use-workspace-data.js";
import { savedDocument } from "./view-state.js";
import { useWorkspace } from "./workspace-context.js";
import { saveWorkspace } from "./workspace-layout.js";

/** Agent 按需访问一份文件时同步它的共享编辑缓冲；不遍历 Tab、不增加一份草稿或保存队列。 */
export function useAgentEditorFiles({
	shown,
	queryClient,
	refresh,
}: Pick<ReturnType<typeof useWorkspaceData>, "shown" | "queryClient" | "refresh">) {
	const { layout, setLayout, projectId, composerActions } = useWorkspace();
	const latest = useRef(layout);
	latest.current = layout;
	const handler = useRef<(call: EditorFileCall) => Promise<EditorFileReply>>(async (call) => ({
		id: call.id,
		ok: false,
		error: "编辑器尚未恢复",
	}));
	const inFlight = useRef(new Map<string, Promise<EditorFileReply>>());
	handler.current = async (call) => {
		const { id, request } = call;
		try {
			if (call.projectId !== projectId || !composerActions.isCurrentProject()) throw new Error("作品已切换，请重试");
			const path = matchingDocumentPath(
				request.path,
				Object.keys(latest.current.documents),
				/Mac|Win/.test(navigator.platform),
			);
			const draft = latest.current.documents[path];
			if (request.operation === "inspect") {
				const file = await invoke("workspace.file.read", { path, expectedProjectId: call.projectId }).catch(
					(error: unknown) => {
						if ((error as { code?: string }).code === "file_not_found") return null;
						throw error;
					},
				);
				if (file && !file.textual) throw new Error("磁盘文件不是 UTF-8 文本，不能与编辑器草稿合并");
				const snapshot: EditorFileSnapshot = {
					draft: draft ? { ...draft, sha256: await contentFingerprint(draft.content) } : null,
					file: file ? { content: file.content, sha256: file.sha256 } : null,
				};
				return { id, ok: true, value: snapshot };
			}
			if (!draft) {
				if (request.operation === "resolve") throw new Error("草稿已保存或被更改，请重新读取文件");
				return { id, ok: true, value: null };
			}
			if (request.operation === "resolve" && (await contentFingerprint(draft.content)) !== request.draftSHA)
				throw new Error("作者在读取后继续编辑，请重新读取两边内容再合并");
			if (latest.current.documents[path] !== draft) throw new Error("作者正在继续编辑，请重试此文件");
			// 先保全原草稿，落盘仍走原 CAS；不会因为磁盘删除而无条件复活文件。
			saveWorkspace(projectId, latest.current);
			const result = await invoke("workspace.file.save", {
				path,
				expectedProjectId: call.projectId,
				content: request.operation === "resolve" ? request.content : draft.content,
				expectedSHA: request.operation === "resolve" ? request.fileSHA : draft.baseSHA,
			});
			if (!composerActions.isCurrentProject()) throw new Error("作品已切换，原作品文件已保存");
			flushSync(() =>
				setLayout((current) => {
					// 合并期间又输入时保留旧基线，下次自动保存必须再次合并，不能把新合并的磁盘内容盖回旧稿。
					if (request.operation === "resolve") {
						if (current.documents[path] !== draft) return current;
						const documents = { ...current.documents };
						delete documents[path];
						return { ...current, documents };
					}
					return savedDocument(current, path, result.content, result.sha256, draft);
				}),
			);
			saveWorkspace(projectId, latest.current);
			void queryClient.invalidateQueries({ queryKey: ["file", shown?.projectId, path] });
			refresh();
			return { id, ok: true, value: null };
		} catch (error) {
			return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	};
	useEffect(() => {
		if (!projectId || projectId !== shown?.projectId || !window.suiming) return;
		return bridge().onEditorFile((call) => {
			const existing = inFlight.current.get(call.id);
			if (existing) return existing;
			const result = handler.current(call).finally(() => inFlight.current.delete(call.id));
			inFlight.current.set(call.id, result);
			return result;
		});
	}, [projectId, shown?.projectId]);
}
