import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "./bridge.js";
import { type ComposerAttachment, contentFingerprint, emptyComposer } from "./composer-state.js";
import { openDocument } from "./document-navigation.js";
import { pageKind, pageTarget, textPathFor } from "./model.js";
import { paneLayout } from "./pane-layout.js";
import { useCurrentDocument } from "./use-current-document.js";
import { useWorkspaceData } from "./use-workspace-data.js";
import {
	activeView,
	type ObservationSelection,
	type OpenOptions,
	type PageState,
	patchView,
	type ViewState,
	type WorkbenchState,
} from "./view-state.js";
import { useWorkspace } from "./workspace-context.js";
import { groupView, updateGroup } from "./workspace-layout.js";

/**
 * 一个文档窗格的状态与动作：窗格自己的标签页、当前文档、引用与打开页面。
 * 外壳（标题栏、左右栏）取当前活动的窗格（不传 `groupId`），分屏的每个文档窗格取自己那一格；
 * 草稿、侧栏与输入框是各窗格共享的，见 `updateGroup`。
 */
export function useWorkspaceGroup(groupId: string | undefined, { onOpen }: { onOpen?: () => void } = {}) {
	const { layout, setLayout, panePriority, setPanePriority, setError, setNotice, setBusy, composerActions } =
		useWorkspace();
	const group = groupId ?? layout.activeGroup;
	const state = groupView(layout, group);
	const setView = useCallback(
		(update: SetStateAction<WorkbenchState>) =>
			setLayout((v) =>
				updateGroup(v, group, (current) => (typeof update === "function" ? update(current) : update)),
			),
		[group, setLayout],
	);
	const layoutLive = useRef(layout);
	layoutLive.current = layout;
	const { queryClient, projection, directory, shown, reviews, reviewsLoading, recent, book, refresh } =
		useWorkspaceData();
	const view = activeView(state);
	const live = useRef(state);
	live.current = state;
	const patch = useCallback((partial: Partial<ViewState>) => setView((v) => patchView(v, partial)), [setView]);
	const selectedText = view.selectedText;
	const selPara = view.selPara;
	const setSelectedText = useCallback(
		(selectedText: string) => patch({ selectedText, ...(!selectedText ? { proseSelection: null } : {}) }),
		[patch],
	);
	const setSelPara = useCallback((selPara: number) => patch({ selPara }), [patch]);
	const gesture = useRef<OpenOptions>({});
	const conversation = shown?.sessions.find((session) => session.id === view.sessionId);
	const draftKey = conversation?.id ?? (view.sessionId || "new");
	const composer = view.composerDrafts[draftKey] ?? emptyComposer();
	const { updateComposer } = composerActions;
	const addReference = (text: string) => {
		if (!text) return;
		updateComposer(draftKey, (draft) => ({
			...draft,
			attachments: [
				...draft.attachments,
				{
					id: crypto.randomUUID(),
					label: text.split("\n")[0] || "作品引用",
					kind: "selection",
					status: "ready",
					content: text,
				},
			],
		}));
	};
	const readReference = async (path: string, selection?: string): Promise<ComposerAttachment> => {
		const candidate = live.current.documents[path];
		const entry = book?.byPath.get(path);
		const data = candidate
			? { content: candidate.content, textual: true }
			: await invoke("workspace.file.read", { path });
		if (!data.textual) throw new Error("当前文件无法作为文字引用，请选择可读取的文档。");
		const status = candidate ? "工作草稿，尚未保存" : entry?.dirty ? "候选文件，尚未提交" : "已提交内容";
		const title = book?.title(entry) || path;
		return {
			id: crypto.randomUUID(),
			// 与左栏、搜索、操作列表、发出后的引用标签同一个名字：Book.title 给正文带「· 正文」，设计只用节名。
			// 原来这里再追加一次，正文引用成了「节名 · 正文 · 正文」，设计引用多出别处都没有的「· 设计」。
			label: selection ? `${title} · 选段` : title,
			kind: selection ? "selection" : "document",
			status: "ready",
			path,
			content: `作品引用：${path}\n基于版本：${shown?.revisionId ?? ""}\n内容状态：${status}\n文件内容 SHA-256：${await contentFingerprint(data.content)}\n${selection ? "选段" : "文件内容"}：\n${selection || data.content}`,
		};
	};
	// 窄窗口一次展示一侧，放大后恢复作者保存的布局。主动打开的一侧优先。
	const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
	useEffect(() => {
		const resize = () => setWindowWidth(window.innerWidth);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	const { showLeft, showRight, rightExpanded, leftWidth, rightWidth, leftMax, rightMax } = paneLayout(
		windowWidth,
		view,
		panePriority,
	);
	const {
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
		rawFile,
		fileDiagnostic,
		editable,
		setBuffer,
		contentFor,
		discard,
	} = useCurrentDocument({ state, view, shown, book, setView });
	async function act(body: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await body();
			refresh();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}
	const pathsOf = (location: PageState): string[] => {
		const path = ["file", "diff"].includes(pageKind(location.page)) ? pageTarget(location.page) : location.page;
		const object = book?.byPath.get(path);
		return [
			...new Set([
				path,
				location.targetPath,
				...(pageKind(location.page) === "artifact" && object?.kind === "story-beat" && object.namespace === "target"
					? [textPathFor(object.localId)]
					: []),
			]),
		].filter(Boolean);
	};
	const protectedLocation = (location: PageState | undefined, v: WorkbenchState) =>
		!!location && pathsOf(location).some((path) => !!v.documents[path]);
	const open = (next: string, extra: Partial<ViewState> = {}, options?: OpenOptions) => {
		setView((v) =>
			openDocument(
				v,
				book,
				next,
				extra,
				options ?? gesture.current,
				protectedLocation(v.tabs[v.active]?.location, v),
			),
		);
		setError("");
		// 一次性提示跟着那一刻：换页之后「已保存，尚未提交」这类话可能已经不是事实。
		setNotice("");
		onOpen?.();
	};
	const showAgent = (prefillText?: string) => {
		setPanePriority("right");
		patch({ right: true, rightMode: "agent" });
		// 输入框里有作者没发出的话时接在后面，不顶掉它（原来整段替换，写到一半的草稿就没了）
		if (prefillText !== undefined)
			updateComposer(draftKey, (draft) => ({
				...draft,
				goal: draft.goal.trim() ? `${draft.goal.trimEnd()}\n${prefillText}` : prefillText,
			}));
	};
	const observe = (observation: ObservationSelection) => {
		setPanePriority("right");
		patch({ observation, right: true, rightMode: "state", expanded: false });
	};
	const locate = (path: string, side: "files" | "spine" | "ids" | "sources" = "files") => {
		setPanePriority("left");
		if (side === "files") {
			const parts = path.split("/");
			patch({
				side,
				sideOpen: true,
				fileSelection: path,
				fileFolders: {
					...view.fileFolders,
					...Object.fromEntries(parts.slice(0, -1).map((_, index) => [parts.slice(0, index + 1).join("/"), true])),
				},
			});
		} else {
			const object = book?.byPath.get(path);
			const volume = object ? book?.volumeOf(object.localId) : undefined;
			patch({
				side,
				sideOpen: true,
				openVols: { ...view.openVols, ...(volume ? { [volume.id]: true } : {}) },
				openGroups: { ...view.openGroups, ...(object ? { [object.kind]: true } : {}) },
			});
		}
		requestAnimationFrame(() => {
			const selected = [
				...(document.querySelectorAll<HTMLElement>(
					"#workbench-left [data-page], #workbench-left [data-file-path]",
				) ?? []),
			].find((element) => element.dataset.filePath === path || element.dataset.page === path);
			selected?.scrollIntoView({ block: "nearest" });
			selected?.focus({ preventScroll: true });
		});
	};
	return {
		group,
		state,
		setView,
		layoutLive,
		live,
		view,
		patch,
		selectedText,
		selPara,
		setSelectedText,
		setSelPara,
		gesture,
		conversation,
		draftKey,
		composer,
		addReference,
		readReference,
		queryClient,
		projection,
		directory,
		shown,
		reviews,
		reviewsLoading,
		recent,
		book,
		refresh,
		showLeft,
		showRight,
		rightExpanded,
		leftWidth,
		rightWidth,
		leftMax,
		rightMax,
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
		rawFile,
		fileDiagnostic,
		editable,
		setBuffer,
		contentFor,
		discard,
		act,
		pathsOf,
		protectedLocation,
		open,
		showAgent,
		observe,
		locate,
	};
}
