import { useQuery } from "@tanstack/react-query";
import { type SetStateAction, useRef } from "react";
import { invoke } from "./bridge.js";
import { CommandError } from "./command-error.js";
import { documentLocation } from "./document-navigation.js";
import type { Book, WorkspaceData } from "./model.js";
import { editDocument, type ViewState, type WorkbenchState } from "./view-state.js";

const EMPTY_FILE = { path: "", content: "", sha256: null as string | null };

/**
 * 一个窗格当前标签页上的文档：读哪个文件、编辑哪个文件、草稿与外部修改、能不能编辑。
 * Beat 页有两份内容（设计与正文），`primary` 读页面本身，`secondary` 读正文；比较页另读所选版本。
 */
export function useCurrentDocument({
	state,
	view,
	shown,
	book,
	setView,
}: {
	state: WorkbenchState;
	view: ViewState;
	shown: WorkspaceData | undefined;
	book: Book | undefined;
	setView: (update: SetStateAction<WorkbenchState>) => void;
}) {
	const tab = state.tabs[state.active];
	const { page, kind, rawPath, file, isBeat, textPath, editPath } = documentLocation(view, book);
	const readRaw =
		kind === "file" || (kind === "artifact" && !!file) || (kind === "diff" && view.diffExternal && !file);
	const primary = useQuery({
		// 读写只有 workspace.file.* 一组；同一路径的主视图与正文视图共用一份缓存。
		queryKey: ["file", shown?.projectId, rawPath],
		queryFn: () => invoke("workspace.file.read", { path: rawPath }),
		enabled: !!shown && (kind === "file" || kind === "diff" || kind === "artifact"),
		retry: false,
	});
	const secondaryPath = textPath || (editPath !== rawPath ? editPath : "");
	const secondary = useQuery({
		queryKey: ["file", shown?.projectId, secondaryPath],
		queryFn: () => invoke("workspace.file.read", { path: secondaryPath }),
		enabled: !!shown && !!secondaryPath,
		retry: false,
	});
	const committed = useQuery({
		queryKey: ["file", shown?.projectId, editPath, view.diffRevision],
		queryFn: () => invoke("workspace.file.read", { path: editPath, revisionId: view.diffRevision ?? "" }),
		enabled: kind === "diff" && !view.diffExternal && !!view.diffRevision && !!editPath,
		retry: false,
	});
	const lastBaseline = useRef("");
	if (committed.isSuccess) lastBaseline.current = committed.data.content;
	const comparisonLoading = primary.isPending || (!view.diffExternal && !!view.diffRevision && committed.isPending);
	const comparisonError = primary.error ?? (!view.diffExternal ? committed.error : null);
	const editQuery = secondaryPath && editPath === secondaryPath ? secondary : primary;
	const editFile = editQuery.isSuccess ? editQuery.data : undefined;
	const absentFile =
		(editQuery.isSuccess && editFile?.sha256 === null && editFile.textual && editFile.writable) ||
		(editQuery.error instanceof CommandError && editQuery.error.code === "file_not_found");
	/** 比较页左侧：外部修改比的是磁盘上的文件，版本比较换版本时先留着上一份，免得闪成空白。 */
	const comparisonOriginal = view.diffExternal
		? (editFile?.content ?? "")
		: view.diffRevision
			? (committed.data?.content ?? lastBaseline.current)
			: "";
	const fileDraft = state.documents[editPath];
	// 尚未创建的正文不是外部删除；只有曾从磁盘读到过的草稿才需要恢复提示。
	const missingFile = absentFile && fileDraft?.baseSHA != null;
	const saved = fileDraft
		? { path: editPath, content: fileDraft.baseContent, sha256: fileDraft.baseSHA }
		: (editFile ?? EMPTY_FILE);
	const buffer = fileDraft?.content ?? editFile?.content ?? "";
	const changed = !!fileDraft;
	const anyChanged = Object.keys(state.documents).length > 0;
	const conflict =
		!missingFile && fileDraft && editFile && editFile.sha256 !== fileDraft.baseSHA ? editFile.content : undefined;
	const rawFile = readRaw && primary.isSuccess && primary.data && "textual" in primary.data ? primary.data : undefined;
	const editWritable =
		editFile && "writable" in editFile && typeof editFile.writable === "boolean" ? editFile.writable : undefined;
	const visibleFile = isBeat && view.beatView === "text" ? secondary.data : primary.data;
	const fileDiagnostic =
		visibleFile && "diagnostic" in visibleFile && typeof visibleFile.diagnostic === "string"
			? visibleFile.diagnostic
			: "";
	const editable =
		!!editPath &&
		((editWritable !== undefined
			? editWritable
			: (isBeat && editPath === textPath && !!secondary.data) ||
				(!readRaw && (!!file || (kind === "diff" && !!primary.data)))) ||
			!!fileDraft);
	const setBuffer = (content: string) => setView((v) => editDocument(v, editPath, content, saved));
	const contentFor = (path: string, content: string | undefined) => state.documents[path]?.content ?? content ?? "";
	const discard = (paths: string[]) =>
		setView((v) => ({
			...v,
			documents: Object.fromEntries(Object.entries(v.documents).filter(([path]) => !paths.includes(path))),
		}));
	return {
		tab,
		page,
		kind,
		rawPath,
		file,
		isBeat,
		textPath,
		editPath,
		primary,
		secondary,
		committed,
		comparisonLoading,
		comparisonError,
		comparisonOriginal,
		editFile,
		saved,
		buffer,
		changed,
		anyChanged,
		conflict,
		missingFile,
		rawFile,
		fileDiagnostic,
		editable,
		setBuffer,
		contentFor,
		discard,
	};
}
