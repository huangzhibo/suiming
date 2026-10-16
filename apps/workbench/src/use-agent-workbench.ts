import type { WorkbenchCall, WorkbenchContext } from "@suiming/sdk";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { captureWorkbenchContext, locateDocumentText } from "./agent-workbench.js";
import { bridge, invoke } from "./bridge.js";
import { CommandError } from "./command-error.js";
import { matchingDocumentPath, openDocument } from "./document-navigation.js";
import { type Book, filePage, type WorkspaceData } from "./model.js";
import { useWorkspace } from "./workspace-context.js";
import { openComparison, updateGroup } from "./workspace-layout.js";

/** 只在 Shell 注册。操作等待文件读取时再次核对当前作品、导航位置和取消状态。 */
export function useAgentWorkbench(book: Book | undefined, shown: WorkspaceData | undefined) {
	const { layout, setLayout, projectId, composerActions } = useWorkspace();
	const latest = useRef(layout);
	latest.current = layout;
	const handle = useRef<(call: WorkbenchCall, cancelled: () => boolean) => Promise<WorkbenchContext>>(async () => {
		throw new Error("界面尚未准备好");
	});
	handle.current = async (call, cancelled) => {
		const request = call.request;
		const check = () => {
			if (cancelled()) throw new Error("本次界面操作已取消");
			if (call.projectId !== projectId || !composerActions.isCurrentProject())
				throw new Error("作者已切换作品，请勿操作其他作品的界面");
			const context = captureWorkbenchContext(latest.current, book);
			if (request.action !== "context" && request.expectedLocation !== context.location)
				throw new Error("作者已切换页面，请重新查询界面；不要为了完成旧操作切回去");
			return context;
		};
		const context = check();
		if (request.action === "context") return context;
		const path = matchingDocumentPath(
			request.path,
			[...Object.keys(latest.current.documents), ...(book?.byPath.keys() ?? [])],
			/Mac|Win/.test(navigator.platform),
		);
		const file = await invoke("workspace.file.read", { path, expectedProjectId: projectId }).catch((error) => {
			if (error instanceof CommandError && error.code === "file_not_found" && latest.current.documents[path])
				return { content: "", sha256: null, textual: true, writable: true };
			throw error;
		});
		check();
		if (!file.textual) throw new Error("当前只能在工作台打开文本文件");
		const draft = latest.current.documents[path];
		if (file.sha256 === null && !draft) throw new Error("文件不存在，无法打开");
		const target =
			request.action === "open" && (request.line !== undefined || request.quote)
				? locateDocumentText(draft?.content ?? file.content, request)
				: undefined;
		if (target && !file.writable && !draft) throw new Error("文件只读，不能在源码编辑器中定位；请直接打开阅读视图");
		flushSync(() =>
			setLayout((current) => {
				// 复用导航与比较，草稿、历史、标签和返回路径仍由原有状态负责。
				if (request.action === "diff")
					return openComparison(
						{ ...current, expanded: false },
						current.activeGroup,
						path,
						request.against === "disk" ? null : (shown?.revisionId ?? null),
						request.against === "disk",
					);
				return updateGroup({ ...current, expanded: false }, current.activeGroup, (state) =>
					openDocument(
						state,
						book,
						filePage(path),
						{
							...(target
								? {
										edit: "edit",
										targetPath: path,
										reveal: { id: call.id, path, ...target },
									}
								: {}),
						},
						{},
						true,
					),
				);
			}),
		);
		return captureWorkbenchContext(latest.current, book);
	};
	useEffect(() => {
		if (!window.suiming || !projectId || shown?.projectId !== projectId) return;
		return bridge().onWorkbench(async (call, cancelled) => {
			try {
				return { id: call.id, ok: true, value: await handle.current(call, cancelled) };
			} catch (error) {
				return { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		});
	}, [projectId, shown?.projectId]);
}
