import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	BookOpen,
	ChevronDown,
	ChevronsUpDown,
	CircleHelp,
	ClipboardCheck,
	Clock,
	Columns2,
	File,
	GitCommitHorizontal,
	Link2,
	MessageSquare,
	PanelLeft,
	PanelRight,
	Pin,
	Plus,
	ScrollText,
	Settings,
	Table2,
	X,
} from "lucide-react";
import {
	createContext,
	type Dispatch,
	lazy,
	type SetStateAction,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { AgentPanel } from "./agent-panel.js";
import { StoryAxis } from "./axis/StoryAxis.js";
import { bridge, invoke } from "./bridge.js";
import { CheckPage, checkQuery } from "./check-page.js";
import { checkNotice } from "./check-result.js";
import type { ComparisonController, ComparisonStatus } from "./code-editor.js";
import { ComparisonActions, ComparisonBaseline, ComparisonOptions } from "./comparison-controls.js";
import { type ComposerAttachment, contentFingerprint, emptyComposer } from "./composer-state.js";
import { openDocument } from "./document-navigation.js";
import { DocumentToolbar } from "./document-toolbar.js";
import { EmptyPage } from "./empty-page.js";
import { FilePane } from "./file-pane.js";
import { HelpDialog } from "./help.js";
import { IdsPane, SearchPane, SourcesPane, SpinePane } from "./left-pane.js";
import { Markdown } from "./markdown.js";
import {
	Book,
	backlinksFor,
	CANDIDATE_VERSION,
	CHECK_PAGE,
	codePoints,
	pageKind,
	pageTarget,
	SPINE_PAGE,
	stripFrontmatter,
	textPathFor,
	type WorkspaceData,
} from "./model.js";
import { ModelSettings } from "./model-settings.js";
import { NavigationModes } from "./navigation-modes.js";
import { NavigationSurface } from "./navigation-surface.js";
import { ObservationPanel } from "./observation-panel.js";
import { ArtifactPage, IssuePage, VersionPage } from "./pages.js";
import { paneLayout } from "./pane-layout.js";
import { PaneResizer } from "./pane-resizer.js";
import { captureReadingSelection, restoreReadingSelection } from "./reading-selection.js";
import { BacklinksPane, EvidencePane } from "./right-pane.js";
import { useAutoHideScrollbars } from "./scrollbars.js";
import { Hint, OverflowHint, ToolButton } from "./ui-bits.js";
import { useComposerSubmit } from "./use-composer-submit.js";
import { useComposerWorkspace } from "./use-composer-workspace.js";
import {
	activeView,
	createTab,
	EMPTY_PAGE,
	editDocument,
	historyMove,
	type ObservationSelection,
	type OpenOptions,
	type PageState,
	pageState,
	patchView,
	type RightMode,
	resolveComparisonLayout,
	resolveOpening,
	savedDocument,
	type ViewState,
	type WorkbenchState,
} from "./view-state.js";
import {
	closeWorkspaceTab,
	groupView,
	loadWorkspace,
	mergeGroup,
	openComparison,
	resolveWorkspaceDocuments,
	saveWorkspace,
	splitGroup,
	updateGroup,
	type WorkspaceLayout,
	workspaceLayout,
	workspaceScreen,
} from "./workspace-layout.js";
import { WorkspacePanes } from "./workspace-panes.js";

const WorkspaceContext = createContext<{
	composerActions: ReturnType<typeof useComposerWorkspace>;
	layout: WorkspaceLayout;
	setLayout: Dispatch<SetStateAction<WorkspaceLayout>>;
	projectId: string;
	setProjectId: Dispatch<SetStateAction<string>>;
	panePriority: "left" | "right";
	setPanePriority: Dispatch<SetStateAction<"left" | "right">>;
	settingsOpen: boolean;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	helpOpen: boolean;
	setHelpOpen: Dispatch<SetStateAction<boolean>>;
	error: string;
	setError: Dispatch<SetStateAction<string>>;
	notice: Notice;
	setNotice: Dispatch<SetStateAction<Notice>>;
	busy: boolean;
	setBusy: Dispatch<SetStateAction<boolean>>;
} | null>(null);
function useWorkspace() {
	const context = useContext(WorkspaceContext);
	if (!context) throw new Error("工作区尚未初始化");
	return context;
}
/**
 * 一次性提示。检查结果这类需要作者去看的，带一个打开详情页的动作；`warn` 用与错误同一种底色，
 * 未通过的检查不该显示成绿色。
 */
type Notice = string | { text: string; tone: "ok" | "warn"; action?: { label: string; page: string } };

export function Workspace() {
	useAutoHideScrollbars();
	const [layout, setLayout] = useState(workspaceLayout);
	const [projectId, setProjectId] = useState("");
	const composerActions = useComposerWorkspace(layout, setLayout, projectId);
	const [panePriority, setPanePriority] = useState<"left" | "right">("right");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState<Notice>("");
	const [busy, setBusy] = useState(false);
	return (
		<WorkspaceContext
			value={{
				composerActions,
				layout,
				setLayout,
				projectId,
				setProjectId,
				panePriority,
				setPanePriority,
				settingsOpen,
				setSettingsOpen,
				helpOpen,
				setHelpOpen,
				error,
				setError,
				notice,
				setNotice,
				busy,
				setBusy,
			}}
		>
			<WorkspaceSurface />
		</WorkspaceContext>
	);
}
const CodeEditor = lazy(() => import("./code-editor.js"));
const EMPTY_FILE = { path: "", content: "", sha256: null as string | null };

function WorkspaceSurface({
	groupId,
	first = false,
	last = false,
}: {
	groupId?: string;
	first?: boolean;
	last?: boolean;
}) {
	const {
		layout,
		setLayout,
		projectId,
		setProjectId,
		panePriority,
		setPanePriority,
		settingsOpen,
		setSettingsOpen,
		helpOpen,
		setHelpOpen,
		error,
		setError,
		notice,
		setNotice,
		busy,
		setBusy,
		composerActions,
	} = useWorkspace();
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
	const queryClient = useQueryClient();
	const projection = useQuery({ queryKey: ["workspace"], queryFn: () => invoke("workspace.show", {}), retry: false });
	const execution = useQuery({ queryKey: ["session-list"], queryFn: () => invoke("session.list", {}) });
	const directory = useQuery({ queryKey: ["project-files"], queryFn: () => invoke("workspace.files", {}) });
	const sessionsOf = useCallback(
		(projectId: string) =>
			execution.data?.projectId === projectId
				? execution.data.sessions.filter((session) => session.kind === "agent")
				: [],
		[execution.data],
	);
	const shown = useMemo<WorkspaceData | undefined>(
		() =>
			(projection.data ? { ...projection.data, sessions: sessionsOf(projection.data.projectId) } : undefined) ??
			(projection.isError && directory.data
				? {
						projectId: directory.data.projectId,
						checkoutPath: directory.data.checkoutPath,
						revisionId: directory.data.revisionId,
						revisions: directory.data.revisions,
						files: [],
						volumes: [],
						dirty: false,
						sessions: sessionsOf(directory.data.projectId),
						storyText: [],
						storyIndexError: projection.error?.message ?? "作品正在读取，可先浏览文件。",
					}
				: undefined),
		[projection.data, projection.error, projection.isError, directory.data, sessionsOf],
	);
	const workspace = { ...projection, data: shown };
	const reviewsQuery = useQuery({
		queryKey: ["reviews"],
		queryFn: () => invoke("workspace.reviews", {}),
		enabled: !!workspace.data,
	});
	const reviews = useMemo(() => reviewsQuery.data ?? [], [reviewsQuery.data]);
	const recent = useQuery({
		queryKey: ["recent-projects", workspace.data?.checkoutPath],
		queryFn: () => bridge().recentProjects(),
		enabled: !!workspace.data && !!window.suiming,
	});
	// Query 的结构共享让 files / volumes / revisions 在内容不变时保持引用；session 用量刷新不重建投影。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只依赖投影用到的字段，刻意排除 runs
	const book = useMemo(
		() => (shown ? new Book(shown) : undefined),
		[
			shown?.files,
			shown?.volumes,
			shown?.revisions,
			shown?.revisionId,
			shown?.dirty,
			shown?.projectId,
			shown?.storyIndexError,
		],
	);
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
	const [closeRequest, setCloseRequest] = useState<{ tabId?: string; paths: string[] } | null>(null);
	const gesture = useRef<OpenOptions>({});
	const conversation = shown?.sessions.find((session) => session.id === view.sessionId);
	const draftKey = conversation?.id ?? (view.sessionId || "new");
	const composer = view.composerDrafts[draftKey] ?? emptyComposer();
	const { updateComposer, onSubmitted, completeAttachment, isCurrentProject, savePosition } = composerActions;
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
			label: `${title}${selection ? " · 选段" : entry?.kind === "story-text" ? " · 正文" : entry?.kind === "story-beat" ? " · 设计" : ""}`,
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
	const query = view.searchQuery;
	const setQuery = (searchQuery: string) => patch({ searchQuery });
	const [libraryOpen, setLibraryOpen] = useState(false);
	// 设置像 Obsidian 一样是模态框：不占标签页，关掉就回到原来的工作面。
	const bodyRef = useRef<HTMLDivElement>(null);
	const mainRef = useRef<HTMLElement>(null);

	const comparisonController = useRef<ComparisonController | null>(null);
	const [comparisonStatus, setComparisonStatus] = useState<ComparisonStatus | null>(null);
	const tab = state.tabs[state.active];
	const page = view.page;
	const kind = pageKind(page);
	const [comparisonWidth, setComparisonWidth] = useState(window.innerWidth);
	useEffect(() => {
		if (kind !== "diff" || !mainRef.current) return;
		const observer = new ResizeObserver(([entry]) => setComparisonWidth(entry?.contentRect.width ?? 0));
		observer.observe(mainRef.current);
		return () => observer.disconnect();
	}, [kind]);
	const comparisonLayout = resolveComparisonLayout(view.diffLayout, comparisonWidth);
	const rawPath = kind === "file" || kind === "diff" ? pageTarget(page) : page;
	const file = kind === "artifact" || kind === "file" || kind === "diff" ? book?.byPath.get(rawPath) : undefined;
	const isBeat = kind === "artifact" && file?.kind === "story-beat" && file.namespace === "target";
	const textPath = isBeat && file ? textPathFor(file.localId) : "";
	const editPath =
		view.edit !== "read" && view.targetPath
			? view.targetPath
			: isBeat
				? view.beatView === "design"
					? rawPath
					: textPath
				: kind === "artifact" || kind === "file" || kind === "diff"
					? rawPath
					: "";
	const refresh = useCallback(() => {
		// context 与被审版本的文件只读已提交版本，query key 里已含 revisionId，不随事件流刷新。
		for (const key of ["workspace", "session-list", "project-files", "file", "reviews", "diff", "tasks", "inbox"])
			void queryClient.invalidateQueries({ queryKey: [key] });
	}, [queryClient]);
	useEffect(() => {
		if (groupId || !window.suiming) return;
		return bridge().onChange((changes) => {
			if (changes.includes("workspace")) refresh();
			else if (changes.includes("execution")) {
				for (const key of ["session-list", "tasks", "inbox"])
					void queryClient.invalidateQueries({ queryKey: [key] });
			}
		});
	}, [refresh, groupId, queryClient]);

	const readRaw =
		kind === "file" || (kind === "artifact" && !!file) || (kind === "diff" && view.diffExternal && !file);
	const primary = useQuery({
		// 读写只有 workspace.file.* 一组；同一路径的主视图与正文视图共用一份缓存。
		queryKey: ["file", shown?.projectId, rawPath],
		queryFn: () => invoke("workspace.file.read", { path: rawPath }),
		enabled: !!shown && (kind === "file" || kind === "diff" || (kind === "artifact" && !!file)),
		retry: false,
	});
	const secondary = useQuery({
		queryKey: ["file", shown?.projectId, textPath],
		queryFn: () => invoke("workspace.file.read", { path: textPath }),
		enabled: !!textPath,
	});
	useEffect(() => {
		if (!groupId || !tab || !isBeat || !view.resolveContent || !secondary.isSuccess || secondary.isFetching) return;
		const content = state.documents[textPath]?.content ?? secondary.data.content;
		setView((current) => resolveOpening(current, tab.id, stripFrontmatter(content).trim().length > 0));
	}, [
		groupId,
		tab,
		isBeat,
		view.resolveContent,
		secondary.isSuccess,
		secondary.isFetching,
		secondary.data,
		state.documents,
		textPath,
		setView,
	]);
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
	const editFile = editPath === textPath && textPath ? secondary.data : primary.data;
	const fileDraft = state.documents[editPath];
	const saved = fileDraft
		? { path: editPath, content: fileDraft.baseContent, sha256: fileDraft.baseSHA }
		: (editFile ?? EMPTY_FILE);
	const buffer = fileDraft?.content ?? editFile?.content ?? "";
	const changed = !!fileDraft;
	const anyChanged = Object.keys(state.documents).length > 0;
	const conflict = fileDraft && editFile && editFile.sha256 !== fileDraft.baseSHA ? editFile.content : undefined;
	const rawFile = readRaw && primary.data && "textual" in primary.data ? primary.data : undefined;
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
			(!!fileDraft && view.edit !== "read"));
	const setBuffer = (content: string) => setView((v) => editDocument(v, editPath, content, saved));
	const contentFor = (path: string, content: string | undefined) => state.documents[path]?.content ?? content ?? "";
	const discard = (paths: string[]) =>
		setView((v) => ({
			...v,
			documents: Object.fromEntries(Object.entries(v.documents).filter(([path]) => !paths.includes(path))),
		}));
	const rebase = () => {
		if (!editFile) return;
		setView((v) => ({
			...v,
			documents: {
				...v.documents,
				[editPath]: { content: buffer, baseContent: editFile.content, baseSHA: editFile.sha256 },
			},
		}));
		setNotice("外部版本已设为基线；编辑内容仍保留，请完成合并后保存。");
	};
	// 项目恢复保留缺失页面与草稿；作品解析失败时仍可进入文件树。
	useEffect(() => {
		if (groupId || !shown || projectId === shown.projectId) return;
		const loaded = loadWorkspace(shown.projectId);
		const restored = book ? resolveWorkspaceDocuments(loaded, book) : loaded;
		const stored = groupView(restored);
		const fallback =
			(book?.order[0] ? book.beat(book.order[0])?.path : undefined) ??
			book?.data.files.find((file) => file.kind === "intent")?.path;
		setLayout(
			updateGroup(restored, restored.activeGroup, () => ({
				...stored,
				sessionId: stored.sessionChosen ? stored.sessionId : (shown.sessions.at(-1)?.id ?? stored.sessionId),
				tabs: stored.tabs.length ? stored.tabs : [createTab(pageState(fallback ?? EMPTY_PAGE))],
				...(projection.isError ? { side: "files" as const } : {}),
			})),
		);
		setProjectId(shown.projectId);
	}, [shown, projectId, book, projection.isError, groupId, setLayout, setProjectId]);
	useEffect(() => {
		if (groupId || !book || projectId !== book.data.projectId) return;
		setLayout((current) => resolveWorkspaceDocuments(current, book));
	}, [book, groupId, projectId, setLayout]);
	useEffect(() => {
		if (groupId || !projectId || projectId !== shown?.projectId) return;
		try {
			saveWorkspace(projectId, layout);
		} catch {
			setError("本机草稿存储空间不足，请保存当前编辑后再关闭窗口。");
		}
	}, [layout, projectId, shown?.projectId, groupId, setError]);
	useEffect(() => {
		if (groupId || !projectId) return;
		const persist = () => {
			try {
				saveWorkspace(projectId, layoutLive.current);
			} catch {
				/* 常规保存已显示错误。 */
			}
		};
		const beforeUnload = (event: BeforeUnloadEvent) => {
			try {
				saveWorkspace(projectId, layoutLive.current);
			} catch {
				if (Object.keys(live.current.documents).length) {
					event.preventDefault();
					event.returnValue = "";
				}
			}
		};
		window.addEventListener("beforeunload", beforeUnload);
		window.addEventListener("pagehide", persist);
		return () => {
			window.removeEventListener("pagehide", persist);
			window.removeEventListener("beforeunload", beforeUnload);
		};
	}, [projectId, groupId]);
	const restoredFor = useRef("");
	const restoreKey = `${tab?.id}:${page}:${view.beatView}:${view.edit}`;
	useEffect(() => {
		if (!mainRef.current || restoredFor.current === restoreKey) return;
		if (((kind === "artifact" || kind === "file") && primary.isLoading) || (isBeat && secondary.isLoading)) return;
		const frame = requestAnimationFrame(() => {
			for (const element of mainRef.current?.querySelectorAll<HTMLElement>("[data-scroll-key]") ?? []) {
				const position = view.scrolls[element.dataset.scrollKey ?? ""];
				if (position) {
					element.scrollTop = position.top;
					element.scrollLeft = position.left;
				}
			}
			const selection = live.current.tabs[live.current.active]?.location.proseSelection;
			if (bodyRef.current && selection) restoreReadingSelection(bodyRef.current, selection);
			restoredFor.current = restoreKey;
		});
		return () => cancelAnimationFrame(frame);
	}, [restoreKey, kind, primary.isLoading, isBeat, secondary.isLoading, view.scrolls]);
	// 正文选择：原生选择落在段落内即形成带段号的引用。
	useEffect(() => {
		const onSelect = () => {
			if (view.edit === "edit") return;
			const selection = window.getSelection();
			const node = selection?.anchorNode;
			const element = node instanceof Element ? node : node?.parentElement;
			const prose = element?.closest("[data-prose]");
			if (!selection || !prose || !bodyRef.current?.contains(prose) || selection.isCollapsed) {
				if (selection?.isCollapsed && prose && bodyRef.current?.contains(prose)) {
					setSelectedText("");
					setSelPara(-1);
				}
				return;
			}
			patch({
				selectedText: selection.toString().slice(0, 12000),
				proseSelection: captureReadingSelection(bodyRef.current, selection),
			});
			setSelPara(Number(element?.closest("p[data-index]")?.getAttribute("data-index") ?? -1));
		};
		document.addEventListener("selectionchange", onSelect);
		return () => document.removeEventListener("selectionchange", onSelect);
	}, [view.edit, setSelectedText, setSelPara, patch]);

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
	async function savePath(path: string) {
		const draft = live.current.documents[path];
		if (!draft) return;
		const args = { path, content: draft.content, expectedSHA: draft.baseSHA };
		const storyFile = book?.byPath.has(path) || book?.order.some((id) => textPathFor(id) === path);
		const result = await invoke("workspace.file.save", args);
		setView((v) => savedDocument(v, path, result.content, result.sha256));
		await queryClient.invalidateQueries({ queryKey: ["file", shown?.projectId, path] });
		setError("");
		setNotice(storyFile ? "已保存，尚未提交" : "已保存");
	}
	const save = () => savePath(editPath);
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
		setLibraryOpen(false);
	};
	const go = (direction: "back" | "forward") =>
		setView((v) => historyMove(v, direction, !!v.tabs[v.active] && protectedLocation(v.tabs[v.active]?.location, v)));
	const activate = (index: number) => setView((v) => ({ ...v, active: index }));
	const remove = (id: string) => setLayout((current) => closeWorkspaceTab(current, group, id));
	const closeTab = (index: number) => {
		const v = live.current;
		const closing = v.tabs[index];
		if (!closing) return;
		const paths = pathsOf(closing.location).filter(
			(path) =>
				v.documents[path] &&
				!layoutLive.current.groups
					.flatMap((group) => group.tabs)
					.some((other) => other.id !== closing.id && pathsOf(other.location).includes(path)),
		);
		if (paths.length) setCloseRequest({ tabId: closing.id, paths });
		else remove(closing.id);
	};
	const newTab = () => open(EMPTY_PAGE, {}, { newTab: true });

	const finishClose = () => {
		const id = closeRequest?.tabId;
		if (id) remove(id);
		else
			patch({
				edit: "read",
				targetPath: "",
			});
		setCloseRequest(null);
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
	const quote = (label: string) =>
		`作品引用：${editPath}\nrevision: ${workspace.data?.revisionId ?? ""}\ncontentSHA: ${saved.sha256 ?? ""}\n${label}：\n${selectedText}`;
	const clearSelection = () => {
		setSelectedText("");
		setSelPara(-1);
		window.getSelection()?.removeAllRanges();
	};
	const referenceSelection = (prefillText?: string) => {
		addReference(quote(selPara >= 0 ? `第 ${selPara + 1} 段选段` : "选段"));
		showAgent(prefillText);
		clearSelection();
	};
	// 选段就地修改：在选段栏里写一句要求，回车直接发给当前对话，不必挪到输入框再组织一遍。
	// 走输入框同一条发送路径（先冻结、可确认、可重试）；输入框里有没发出的内容、有待确认的发送或对话暂停时
	// 不直接发——会顶掉作者的草稿或被拒收——改为把选段和这句要求接进输入框，由作者一起发。
	const inlineEdit = useComposerSubmit({
		composer,
		draftKey,
		session: conversation,
		updateComposer,
		onSubmitted,
		refresh,
		isCurrentProject,
	});
	const [editRequest, setEditRequest] = useState("");
	const requestEdit = () => {
		const request = editRequest.trim();
		if (!request || inlineEdit.busy) return;
		const goal = `请修改这一段：${request}`;
		const attachment: ComposerAttachment = {
			id: crypto.randomUUID(),
			label: selPara >= 0 ? `第 ${selPara + 1} 段选段` : "选段",
			kind: "selection",
			status: "ready",
			content: quote(selPara >= 0 ? `第 ${selPara + 1} 段选段` : "选段"),
		};
		const occupied =
			composer.goal.trim() !== "" ||
			composer.attachments.length > 0 ||
			composer.pending !== undefined ||
			conversation?.status === "paused";
		if (occupied) {
			updateComposer(draftKey, (draft) => ({
				...draft,
				goal: draft.goal.trim() ? `${draft.goal.trimEnd()}\n${goal}` : goal,
				attachments: [...draft.attachments, attachment],
			}));
		} else {
			void inlineEdit.submitDraft({
				...emptyComposer(),
				...(composer.model ? { model: composer.model } : {}),
				goal,
				attachments: [attachment],
			});
		}
		showAgent();
		setEditRequest("");
		clearSelection();
	};
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (
				groupId !== layout.activeGroup ||
				event.isComposing ||
				closeRequest ||
				settingsOpen ||
				helpOpen ||
				document.querySelector('[role="dialog"], [role="menu"]')
			)
				return;
			if ((event.metaKey || event.ctrlKey) && event.key === "t") {
				event.preventDefault();
				newTab();
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "w") {
				event.preventDefault();
				closeTab(view.active);
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "s") {
				event.preventDefault();
				if (changed) void act(save);
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "e" && editable && kind !== "diff") {
				event.preventDefault();
				if (view.edit === "read") beginEdit(editPath);
				else finishTask();
			}
			if ((event.metaKey || event.ctrlKey) && event.key === "k") {
				event.preventDefault();
				setPanePriority("left");
				patch({ side: "search", sideOpen: true });
			}
			if (event.key === "Escape") {
				setSelectedText("");
				setSelPara(-1);
			}
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	});

	const sideRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!showLeft) return;
		for (const element of sideRef.current?.querySelectorAll<HTMLElement>("[data-side-scroll]") ?? [])
			element.scrollTop = live.current.sidePositions[view.side]?.[element.dataset.sideScroll ?? ""] ?? 0;
	}, [view.side, showLeft]);
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
	const beginEdit = (path: string) =>
		patch({
			targetPath: path,
			edit: "edit",
		});
	const beginDiff = (path: string, external = false) =>
		setLayout((current) =>
			openComparison(current, group, path, external ? null : (shown?.revisionId ?? null), external),
		);
	const finishTask = () => patch({ edit: "read", targetPath: "" });

	// 加载中给一个安静的加载态，只有确实没有作品才请作者打开或新建（判定见 workspaceScreen）。
	const surface = workspaceScreen({ show: projection.status, files: directory.status });
	if (surface === "loading")
		return (
			<main className="grid h-screen place-items-center bg-background">
				<div className="drag absolute inset-x-0 top-0 h-12" />
				<div className="flex flex-col items-center gap-4">
					<div className="grid size-[54px] place-items-center rounded-xl bg-muted font-serif text-[29px] text-foreground">
						燧
					</div>
					<span className="text-xs text-muted-foreground">正在打开作品…</span>
				</div>
			</main>
		);

	if (surface === "welcome" || !workspace.data || !book)
		return (
			<main className="relative h-screen bg-background px-[12vw] py-[14vh]">
				<div className="drag absolute inset-x-0 top-0 h-12" />
				<div className="mb-11 grid size-[54px] place-items-center rounded-xl bg-muted font-serif text-[29px] text-foreground">
					燧
				</div>
				<span className="text-[10px] font-semibold tracking-[2px] text-muted-foreground">
					SUIMING / 长篇创作工作台
				</span>
				<h1 className="my-[22px] font-serif text-[51px] leading-[1.6] font-medium tracking-[3px]">
					让你的故事，
					<br />
					从火种成为世界。
				</h1>
				<p className="text-sm leading-[2] text-muted-foreground">
					阅读、写作、推敲人物与因果。
					<br />
					与专属 Agent 一起，让每一次修改都有来处。
				</p>
				<div className="mt-8 mb-6 flex gap-3">
					<Button
						size="lg"
						onClick={() =>
							act(async () => {
								await bridge().chooseProject(false);
							})
						}
					>
						打开作品 ↗
					</Button>
					<Button
						size="lg"
						variant="outline"
						onClick={() =>
							act(async () => {
								await bridge().chooseProject(true);
							})
						}
					>
						开始新作
					</Button>
				</div>
				<p className="text-[11px] text-muted-foreground">作品保存在你的电脑上，不需要云端账号。</p>
				{(error || workspace.error) && (
					<p className="mt-2 text-[11.5px] leading-[1.7] whitespace-pre-wrap text-[#a06443]">
						{error || workspace.error?.message}
					</p>
				)}
			</main>
		);

	const data = workspace.data;
	const report = kind === "issue" ? reviews.find((item) => item.id === pageTarget(page)) : undefined;
	const backlinks = file ? backlinksFor(book, file.path) : [];
	const readingContent = buffer;
	const textCount = book.order.filter((id) => book.text(id)).length;
	const dirtyCount = data.files.filter((item) => item.dirty).length;
	const workName = data.checkoutPath.split("/").at(-1) ?? "作品";
	const agentNeedsInput = data.sessions.some((session) => session.status === "paused");
	const rightButton = (mode: RightMode, label: string, icon: React.ReactNode, badge = false) => (
		<ToolButton
			label={label}
			description={
				{
					back: "查看哪些作品内容引用了当前对象",
					evidence: "查看当前内容的版本、来源与证据",
					state: "查看指定故事位置的人物、资源与读者期待状态",
					agent: "与 Agent 讨论创作、修改作品",
				}[mode]
			}
			on={view.rightMode === mode}
			onClick={() => {
				setPanePriority("right");
				if (mode === "state") {
					const subject: ObservationSelection["subject"] =
						file && (file.kind === "character" || file.kind === "resource" || file.kind === "story-contract")
							? { kind: file.kind === "story-contract" ? ("contract" as const) : file.kind, id: file.localId }
							: undefined;
					const storyBeatId =
						file && (isBeat || file.kind === "story-text")
							? file.localId
							: kind === "spine" && view.axisSelected
								? view.axisSelected
								: view.observation?.storyBeatId;
					patch({
						rightMode: mode,
						expanded: false,
						observation: storyBeatId
							? { storyBeatId, phase: view.observation?.phase ?? "before", ...(subject ? { subject } : {}) }
							: null,
					});
				} else patch({ rightMode: mode, expanded: false });
			}}
		>
			{icon}
			{badge && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber" />}
		</ToolButton>
	);
	const paneProps = { book, reviews, view, page, patch, open };
	const tabIcon = (tab: string) => {
		const kind = pageKind(tab);
		if (kind === "diff") return <Columns2 className="size-[14px] shrink-0 text-muted-foreground" />;
		if (kind === "spine") return <Table2 className="size-[14px] shrink-0 text-muted-foreground" />;
		if (kind === "check") return <ClipboardCheck className="size-[14px] shrink-0 text-muted-foreground" />;
		if (
			kind === "artifact" &&
			(book.byPath.get(tab)?.kind === "story-beat" || book.byPath.get(tab)?.kind === "story-text")
		)
			return <BookOpen className="size-[14px] shrink-0 text-muted-foreground" />;
		return <File className="size-[14px] shrink-0 text-muted-foreground" />;
	};
	const split = (orientation: "horizontal" | "vertical", paired = false) => {
		setLayout((current) => {
			let base = current;
			let location: PageState | undefined;
			if (paired && isBeat) {
				const original = groupView(current, group).tabs[state.active]?.location;
				location =
					original?.beatView === "text"
						? { ...original, resolveContent: false }
						: { ...pageState(page), beatView: "text" };
				if (original?.beatView === "text")
					base = updateGroup(base, group, (value) =>
						patchView(value, { beatView: "design", edit: "read", targetPath: "" }),
					);
			}
			return splitGroup(base, group, orientation, location);
		});
	};
	const tabStrip = (
		<div
			className="drag relative flex h-(--workbench-header-height) min-w-0 shrink-0 items-end border-b border-line bg-titlebar pl-2"
			// 用外边距避开侧栏按钮；padding 仍属于 Electron 原生拖动区，会吞掉鼠标点击。
			style={{
				marginLeft: first && !showLeft ? 86 : undefined,
				paddingLeft: first && !showLeft ? 0 : undefined,
				marginRight: last && !showRight ? 44 : undefined,
			}}
		>
			{view.tabs.map((item, index) => (
				<ContextMenu key={item.id}>
					<ContextMenuTrigger asChild>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: 标签本身承载关闭按钮，不能再嵌套 button */}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用户通过标签内的可聚焦元素与 ⌘W 操作 */}
						<div
							className="tab-btn"
							data-tab-id={item.id}
							data-active={index === view.active}
							onClick={() => activate(index)}
							onAuxClick={(event) => event.button === 1 && closeTab(index)}
						>
							{item.pinned ? (
								<Pin className="size-3 shrink-0 text-muted-foreground" />
							) : (
								tabIcon(item.location.page)
							)}
							{protectedLocation(item.location, state) && (
								<span className="size-1.5 shrink-0 rounded-full bg-amber" role="img" aria-label="未保存" />
							)}
							<OverflowHint content={book.pageTitle(item.location.page, reviews)}>
								<button
									type="button"
									className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13px]"
									aria-current={index === view.active ? "page" : undefined}
									onClick={() => activate(index)}
								>
									{book.pageTitle(item.location.page, reviews)}
								</button>
							</OverflowHint>
							<Hint content={"关闭标签页 · ⌘/Ctrl W"}>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label="关闭标签"
									className={`size-5 shrink-0 rounded text-muted-foreground hover:text-foreground ${index === view.active ? "" : "hidden"}`}
									onClick={(event) => {
										event.stopPropagation();
										closeTab(index);
									}}
								>
									<X className="size-[11px]" />
								</Button>
							</Hint>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuGroup>
							<ContextMenuItem
								onSelect={() =>
									setView((v) => ({
										...v,
										tabs: v.tabs.map((t) => (t.id === item.id ? { ...t, pinned: !t.pinned } : t)),
									}))
								}
							>
								{item.pinned ? "取消固定标签页" : "固定标签页"}
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => open(item.location.page, item.location, { newTab: true })}>
								复制标签页
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => closeTab(index)}>关闭标签页</ContextMenuItem>
						</ContextMenuGroup>
					</ContextMenuContent>
				</ContextMenu>
			))}
			<ToolButton
				label="新标签页"
				description="打开空白选择页 · ⌘/Ctrl T"
				className="ml-1.5 self-center text-muted-foreground"
				onClick={newTab}
			>
				<Plus className="size-[14px]" />
			</ToolButton>
			<span className="flex-1" />
			{view.tabs.length > 1 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Hint content={"查看已打开的标签页"}>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="标签页列表"
								className="no-drag mr-1.5 size-7 self-center text-muted-foreground"
							>
								<ChevronDown className="size-[14px]" />
							</Button>
						</Hint>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="max-w-[320px]">
						{view.tabs.map((item, index) => (
							<DropdownMenuItem
								key={item.id}
								onSelect={() => activate(index)}
								className={index === view.active ? "font-medium" : ""}
							>
								{tabIcon(item.location.page)}
								<span className="truncate">{book.pageTitle(item.location.page, reviews)}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
	const documentPane = (
		<main
			ref={mainRef}
			style={{ containerType: "inline-size", containerName: "document" }}
			onScrollCapture={(event) => {
				const element = event.target as HTMLElement;
				const key = element.dataset.scrollKey;
				if (key)
					patch({
						scrolls: { ...view.scrolls, [key]: { top: element.scrollTop, left: element.scrollLeft } },
					});
			}}
			className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-white min-h-0`}
		>
			<DocumentToolbar
				book={book}
				view={view}
				file={file}
				reports={reviews}
				patch={patch}
				open={open}
				go={go}
				locate={locate}
				edit={beginEdit}
				split={split}
				merge={layout.groups.length > 1 ? () => setLayout((v) => mergeGroup(v, group)) : undefined}
				selectContent={(beatView) =>
					patch({
						beatView,
						targetPath: view.edit === "edit" ? (beatView === "design" ? rawPath : textPath) : "",
					})
				}
				comparisonActions={
					kind === "diff" ? (
						<ComparisonActions
							controller={comparisonController}
							layout={comparisonLayout}
							onLayout={(diffLayout) => patch({ diffLayout })}
							status={comparisonLoading || comparisonError ? null : comparisonStatus}
							identical={
								view.diffExternal
									? "与外部文件内容相同"
									: view.diffRevision === shown?.revisionId
										? "没有未提交修改"
										: "与所选版本内容相同"
							}
						/>
					) : undefined
				}
				comparisonOptions={
					kind === "diff" ? <ComparisonOptions view={view} patch={patch} layout={comparisonLayout} /> : undefined
				}
				diff={beginDiff}
				finish={finishTask}
				editable={editable}
				copy={(path) =>
					void act(async () => {
						await navigator.clipboard.writeText(path);
						setNotice("已复制相对路径");
					})
				}
				system={(path) => void act(() => invoke("workspace.file.open", { path, action: "reveal" }))}
			/>
			{kind === "artifact" && fileDiagnostic && (
				<p role="status" className="border-b bg-amber-bg px-4 py-2 text-xs text-amber">
					{fileDiagnostic}
					{editable ? " 可切换到编辑视图修复。" : ""}
				</p>
			)}
			{primary.error && kind === "artifact" && (
				<p role="status" className="border-b bg-amber-bg px-4 py-2 text-xs text-amber">
					当前文件无法读取：{primary.error.message}。已有草稿仍保留。
				</p>
			)}
			{/* 只在需要作者动手时出现：有未保存的修改。保存后不再常驻「已保存」——文件与最新版本不同由标题下的「未提交」说，
			    同一个事实不在一屏里说三遍（2026-10-01 作者看到「候选已保存」与两处「候选未提交」并列，以为是两种矛盾的状态）。 */}
			{changed && (
				<div className="flex shrink-0 items-center justify-end gap-2 border-b px-3 py-1.5">
					<span className="text-[11px] text-amber">未保存</span>
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							setCloseRequest({ paths: [editPath] });
							setError("");
						}}
					>
						取消编辑
					</Button>
					<Button size="xs" disabled={busy} onClick={() => act(save)}>
						保存 ⌘S
					</Button>
				</div>
			)}
			{groupId === layout.activeGroup && (error || notice || projection.error) && (
				<div
					className={`flex shrink-0 justify-between gap-3 px-4 py-2 text-xs leading-normal [overflow-wrap:anywhere] ${error || (typeof notice === "object" && notice.tone === "warn") ? "bg-[#f7e9df] text-[#995934]" : "bg-green-bg text-[#1f4d37]"}`}
					role="status"
				>
					<span>
						{error ||
							(typeof notice === "object" ? notice.text : notice) ||
							`作品暂时无法解析，请在文件树中修复：${projection.error?.message}`}
						{!error && typeof notice === "object" && notice.action && (
							<Button
								variant="link"
								size="xs"
								className="ml-2 h-auto p-0 text-xs text-inherit underline"
								data-page={notice.action.page}
								onClick={() => notice.action && open(notice.action.page)}
							>
								{notice.action.label}
							</Button>
						)}
					</span>
					<Hint content={"关闭提示"}>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="size-5 text-inherit hover:bg-black/5"
							onClick={() => {
								setError("");
								setNotice("");
							}}
							aria-label="关闭提示"
						>
							<X className="size-[12px]" />
						</Button>
					</Hint>
				</div>
			)}
			{conflict !== undefined && (
				<div className="mx-4 my-3 shrink-0 rounded-lg border border-amber-line bg-amber-bg px-3.5 py-3 text-xs leading-[1.7]">
					<strong>文件在外部发生了修改</strong>
					<p className="mt-1 mb-2 text-ink-3">你的编辑保留在这里。先比较两个版本，再决定如何合并。</p>
					<Button variant="outline" size="xs" className="mr-1.5" onClick={() => beginDiff(editPath, true)}>
						比较外部修改
					</Button>
					<Button variant="outline" size="xs" onClick={rebase}>
						以外部版本为合并基线
					</Button>
				</div>
			)}
			{(kind === "artifact" || kind === "file") && view.edit === "edit" && editable && (
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
					<Suspense fallback={<p className="p-5 text-[11.5px] text-muted-foreground">正在打开编辑器…</p>}>
						<CodeEditor
							content={buffer}
							path={editPath}
							measure={
								kind === "artifact"
									? editPath === textPath || file?.kind === "story-text"
										? "reading"
										: "document"
									: "full"
							}
							autoFocus={groupId === layout.activeGroup}
							key={`${tab?.id}:${editPath}:${view.edit}`}
							position={view.editors[`${editPath}:${view.edit}`]}
							onPosition={(position) =>
								patch({ editors: { ...view.editors, [`${editPath}:${view.edit}`]: position } })
							}
							onChange={(value) => {
								setBuffer(value);
							}}
							onSelection={(value) => setSelectedText(value.slice(0, 12000))}
						/>
					</Suspense>
				</div>
			)}
			{kind === "diff" && (
				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					{(comparisonLoading || comparisonError) && (
						<div
							className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 p-6 text-sm text-muted-foreground"
							role="status"
						>
							{comparisonError ? (
								<div>
									无法读取比较内容：{comparisonError.message}
									<Button
										size="xs"
										variant="outline"
										className="ml-2"
										onClick={() => {
											void primary.refetch();
											if (!view.diffExternal && view.diffRevision) void committed.refetch();
										}}
									>
										重试
									</Button>
								</div>
							) : (
								"正在读取比较内容…"
							)}
						</div>
					)}
					{primary.data && (
						<Suspense fallback={<p className="p-5 text-xs text-muted-foreground">正在打开比较…</p>}>
							<CodeEditor
								original={
									view.diffExternal
										? (editFile?.content ?? "")
										: view.diffRevision
											? (committed.data?.content ?? lastBaseline.current)
											: ""
								}
								content={buffer}
								path={editPath}
								measure={file?.kind === "story-text" || editPath.startsWith("text/") ? "reading" : "full"}
								key={`${tab?.id}:${editPath}:diff`}
								autoFocus={false}
								position={view.editors[`${editPath}:diff`]}
								onPosition={(position) =>
									patch({ editors: { ...view.editors, [`${editPath}:diff`]: position } })
								}
								onChange={setBuffer}
								comparison={{
									controller: comparisonController,
									layout: comparisonLayout,
									onStatus: (next) =>
										setComparisonStatus((old) =>
											old?.count === next?.count && old?.active === next?.active ? old : next,
										),
									before: <ComparisonBaseline book={book} view={view} patch={patch} />,
									after: <span>当前内容{changed ? " · 未保存" : ""}</span>,
									ratio: view.diffRatio,
									onRatio: (diffRatio) => patch({ diffRatio }),
									sync: view.diffSync,
									changesOnly: view.diffChangesOnly,
								}}
							/>
						</Suspense>
					)}
				</div>
			)}
			{kind !== "diff" && !((kind === "artifact" || kind === "file") && view.edit !== "read" && editable) && (
				<div
					className={`relative min-h-0 flex-1 ${kind === "artifact" ? "overflow-auto [scrollbar-gutter:stable]" : "flex flex-col overflow-hidden"}`}
					ref={bodyRef}
					data-scroll-key={`body:${view.beatView}`}
					key={restoreKey}
				>
					{kind === "empty" && (
						<EmptyPage
							book={book}
							files={
								directory.data?.entries.filter((entry) => entry.type === "file").map((entry) => entry.path) ??
								[]
							}
							recent={state.recentPages}
							open={open}
						/>
					)}
					{kind === "file" && (
						<>
							{(rawFile?.diagnostic || primary.error) && (
								<p role="status" className="border-b bg-amber-bg p-3 text-xs text-amber">
									{rawFile?.diagnostic || primary.error?.message}
								</p>
							)}
							{primary.isLoading ? (
								<p className="p-8 text-xs text-muted-foreground">正在读取文件…</p>
							) : rawFile?.textual ? (
								!file && rawPath.endsWith(".md") ? (
									<div
										className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]"
										data-scroll-key="file-preview"
									>
										<div className="document-page" data-measure="document">
											<Markdown
												className="design-body"
												content={stripFrontmatter(contentFor(rawPath, rawFile.content))}
											/>
										</div>
									</div>
								) : (
									<Suspense fallback={<p className="p-8 text-xs">正在打开源文件…</p>}>
										<CodeEditor
											key={`${tab?.id}:${rawPath}:source`}
											path={rawPath}
											content={contentFor(rawPath, rawFile.content)}
											position={view.editors[`${rawPath}:source`]}
											onPosition={(position) =>
												patch({ editors: { ...view.editors, [`${rawPath}:source`]: position } })
											}
										/>
									</Suspense>
								)
							) : (
								rawFile && (
									<div className="p-8 text-sm">
										<h1 className="mb-2 text-lg font-medium">{rawPath.split("/").at(-1)}</h1>
										<p className="mb-5 text-muted-foreground">
											{rawFile.size.toLocaleString()} 字节 · 此文件不支持文本预览
										</p>
										<Button
											size="sm"
											variant="outline"
											onClick={() =>
												act(() => invoke("workspace.file.open", { path: rawPath, action: "open" }))
											}
										>
											使用系统应用打开
										</Button>
									</div>
								)
							)}
						</>
					)}
					{kind === "artifact" && file && !view.resolveContent && (
						<ArtifactPage
							book={book}
							reviews={reviews}
							file={file}
							content={contentFor(rawPath, primary.data?.content)}
							{...(isBeat
								? {
										text: {
											file: book.text(file.localId),
											content: contentFor(textPath, secondary.data?.content),
										},
									}
								: {})}
							view={view.beatView}
							selected={selPara}
							open={open}
							delegateWrite={() => {
								addReference(
									`作品引用：${file.path}\nrevision: ${data.revisionId}\n这个 Beat 尚无 StoryText。`,
								);
								showAgent(`请写「${book.beatTitle(file.localId)}」的正文`);
							}}
							openEditor={() => {
								patch({ beatView: "text" });
								beginEdit(textPath);
							}}
						/>
					)}
					{kind === "artifact" && file && view.resolveContent && (
						<p role="status" className="p-8 text-xs text-muted-foreground">
							{secondary.error ? "正文读取失败，请稍后重试或切换到设计。" : "正在读取内容…"}
						</p>
					)}
					{kind === "artifact" && !file && (
						<div className="px-8 py-20 text-center text-muted-foreground">
							<h2 className="mb-2 text-base font-medium">这个文件已不在作品目录中</h2>
							<p className="text-xs text-faint">{page}</p>
						</div>
					)}
					{kind === "spine" && (
						<StoryAxis
							book={book}
							reviews={reviews}
							selected={view.axisSelected}
							volume={view.axisVolume}
							onVolume={(axisVolume) => patch({ axisVolume, axisColumn: null })}
							column={view.axisColumn}
							labelWidth={view.axisLabelWidth}
							onLabelWidth={(axisLabelWidth) => patch({ axisLabelWidth })}
							onColumn={(axisColumn) => patch({ axisColumn })}
							onSelect={(axisSelected) => patch({ axisSelected })}
							onObserve={(storyBeatId) => observe({ storyBeatId, phase: "before" })}
							open={open}
							expanded={{
								characters: view.axisAllCharacters,
								worlds: view.axisWorlds,
								resources: view.axisResources,
							}}
							onExpand={(group, on) =>
								patch(
									group === "characters"
										? { axisAllCharacters: on }
										: group === "worlds"
											? { axisWorlds: on }
											: { axisResources: on },
								)
							}
							showFindings={view.axisFindings}
							onToggleFindings={(axisFindings) => patch({ axisFindings })}
							range={view.axisRange}
							onRange={(axisRange) => patch({ axisRange })}
							onReference={(axisRange) => {
								const ids = book.order.slice(book.ordinal(axisRange.start), book.ordinal(axisRange.end) + 1);
								addReference(
									`作品引用：故事轴区间 ${axisRange.start} → ${axisRange.end}（${ids.length} 个 Beat：${ids.map((id) => book.beatTitle(id)).join("、")}）\nrevision: ${data.revisionId}`,
								);
								showAgent();
							}}
							onHelp={() => setHelpOpen(true)}
						/>
					)}
					{kind === "check" && (
						<CheckPage
							book={book}
							open={open}
							disabledReason={busy ? "正在处理，请稍候" : anyChanged ? "请先保存未保存的修改" : undefined}
							onRecheck={() => setNotice("")}
						/>
					)}
					{kind === "issue" && report && (
						<IssuePage
							key={`${tab?.id}:${report.id}`}
							scrolls={view.scrolls}
							selection={view.review}
							onSelection={(review) => patch({ review })}
							book={book}
							report={report}
							open={open}
							openInText={(path) =>
								open(path, { edit: "edit", beatView: path.startsWith("text/") ? "text" : "design" })
							}
							sendToAgent={(text) => {
								addReference(`审稿 ${report.id}\n${text}`);
								showAgent();
							}}
						/>
					)}
					{kind === "issue" && !report && (
						<div className="px-8 py-20 text-center text-muted-foreground">
							<h2 className="mb-2 text-base font-medium">
								{reviewsQuery.isLoading ? "正在读取审稿报告…" : "找不到这份审稿报告"}
							</h2>
						</div>
					)}
					{kind === "version" && (
						<VersionPage
							positions={view.editors}
							positionChange={(path, position) => patch({ editors: { ...view.editors, [path]: position } })}
							selected={view.versionFile}
							onSelect={(versionFile) => patch({ versionFile })}
							key={`${tab?.id}:${pageTarget(page)}`}
							book={book}
							revisionId={pageTarget(page)}
							open={open}
						/>
					)}
				</div>
			)}
			{selectedText && kind === "artifact" && (
				<div className="pointer-events-none absolute inset-x-0 bottom-14 z-[5] flex justify-center px-3">
					<div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-lg bg-foreground py-1.5 pr-1.5 pl-3 text-xs text-[#fafafa] shadow-[0_8px_24px_#00000033]">
						<span className="text-faint">
							已选择 {codePoints(selectedText)} 字{selPara >= 0 ? ` · 第 ${selPara + 1} 段` : ""} ·{" "}
							{file?.localId} · {book.headLabel}
						</span>
						<Input
							aria-label="说明要怎么改"
							placeholder="说明要怎么改，回车发送"
							value={editRequest}
							onChange={(event) => setEditRequest(event.target.value)}
							onKeyDown={(event) => {
								// 中文输入法确认候选字的回车不算发送
								if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
								event.preventDefault();
								requestEdit();
							}}
							className="h-6 w-56 border-white/20 bg-white/10 text-xs text-white placeholder:text-white/50"
						/>
						<Button size="xs" disabled={!editRequest.trim() || inlineEdit.busy} onClick={requestEdit}>
							修改
						</Button>
						<Button size="xs" className="bg-ink-3 hover:bg-ink-3/90" onClick={() => referenceSelection()}>
							询问 Agent
						</Button>
						<Hint content={"取消选择"}>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="取消选择"
								className="text-faint hover:bg-white/10 hover:text-white"
								onClick={clearSelection}
							>
								<X className="size-[12px]" />
							</Button>
						</Hint>
					</div>
				</div>
			)}
			{/* 紧凑状态栏：贴底单行 24px，窄窗按信息组换行，不遮住内容与操作。 */}
			<div
				className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-x-4 px-3 text-xs leading-6 whitespace-nowrap text-muted-foreground"
				role="status"
				aria-label="作品与当前对象状态"
			>
				{/* 底栏只说整部作品：版本、未提交与正文进度。字数、属性这类对象信息在页面标题下。 */}
				<span>
					{book.headLabel} ·{" "}
					{data.dirty ? (
						<Button
							variant="link"
							size="xs"
							className="h-auto p-0 text-xs text-inherit"
							data-page={CANDIDATE_VERSION}
							onClick={() => open(CANDIDATE_VERSION)}
						>
							{dirtyCount ? `${dirtyCount} 个文件未提交` : "有未提交的修改"}
						</Button>
					) : (
						"已提交"
					)}
				</span>
				<span>
					正文 {textCount} / {book.order.length}
				</span>
			</div>
		</main>
	);
	const closeDialog = (
		<Dialog
			open={!!closeRequest}
			onOpenChange={(on) => {
				if (!on) setCloseRequest(null);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>保留未保存的修改？</DialogTitle>
					<DialogDescription>这些文件还有未保存内容。保存会写入项目目录，放弃会移除共享草稿。</DialogDescription>
				</DialogHeader>
				<ul className="max-h-40 overflow-auto text-xs text-muted-foreground">
					{closeRequest?.paths.map((path) => (
						<li key={path} className="py-1 break-all">
							{path}
						</li>
					))}
				</ul>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={busy} onClick={() => setCloseRequest(null)}>
						取消
					</Button>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => {
							discard(closeRequest?.paths ?? []);
							finishClose();
						}}
					>
						放弃修改
					</Button>
					<Button
						disabled={busy}
						onClick={() =>
							act(async () => {
								for (const path of closeRequest?.paths ?? []) await savePath(path);
								finishClose();
							})
						}
					>
						保存并继续
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
	if (groupId)
		return (
			<NavigationSurface
				open={open}
				gesture={gesture}
				className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-chrome"
			>
				<section
					aria-label="文档窗格"
					data-pane-id={groupId}
					data-pane-active={groupId === layout.activeGroup}
					className="flex h-full min-h-0 min-w-0 flex-col"
					onPointerDownCapture={() =>
						setLayout((v) => (v.activeGroup === group ? v : { ...v, activeGroup: group }))
					}
					onFocusCapture={() => setLayout((v) => (v.activeGroup === group ? v : { ...v, activeGroup: group }))}
				>
					{tabStrip}
					{documentPane}
				</section>
				{closeDialog}
			</NavigationSurface>
		);
	return (
		<NavigationSurface open={open} gesture={gesture}>
			<div className="drag relative flex h-(--workbench-header-height) shrink-0 items-stretch border-b border-line bg-titlebar">
				<div className="w-11 shrink-0" />
				{showLeft ? (
					<div
						data-pane-header="left"
						style={{ width: leftWidth }}
						className="flex shrink-0 items-center gap-[3px] border-r border-line pr-1 pl-(--window-controls-inset)"
					>
						<NavigationModes
							value={view.side}
							onChange={(side) => {
								setPanePriority("left");
								patch({ side, sideOpen: true });
							}}
						/>
						<ToolButton label="收起左栏" onClick={() => patch({ sideOpen: false })}>
							<PanelLeft />
						</ToolButton>
					</div>
				) : (
					<div className="relative z-[5] flex items-center bg-titlebar pr-1.5 pl-(--window-controls-inset)">
						<ToolButton
							label="展开左栏"
							onClick={() => {
								setPanePriority("left");
								patch({ sideOpen: true });
							}}
						>
							<PanelLeft />
						</ToolButton>
					</div>
				)}
				<div className={rightExpanded ? "hidden" : "min-w-0 flex-1"} />
				{showRight ? (
					<div
						data-pane-header="right"
						style={rightExpanded ? undefined : { width: rightWidth }}
						className={`flex shrink-0 items-center gap-1.5 bg-titlebar px-2 ${rightExpanded ? "flex-1" : "border-l border-line"}`}
					>
						{rightButton("back", "被引用", <Link2 />)}
						{rightButton("evidence", "依据", <ScrollText />)}
						{rightButton("state", "故事状态", <Clock />)}
						{rightButton("agent", "对话", <MessageSquare />, agentNeedsInput)}
						<span className="flex-1" />
						<ToolButton label="收起右栏" onClick={() => patch({ right: false, expanded: false })}>
							<PanelRight />
						</ToolButton>
					</div>
				) : (
					<div className="relative z-[5] flex items-center bg-titlebar px-2">
						<ToolButton
							label="展开右栏"
							onClick={() => {
								setPanePriority("right");
								patch({ right: true });
							}}
						>
							<PanelRight />
							{agentNeedsInput && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-amber" />}
						</ToolButton>
					</div>
				)}
			</div>
			<div className="flex min-h-0 flex-1 divide-x divide-line">
				<nav aria-label="全局动作" className="flex w-11 shrink-0 flex-col items-center gap-2 py-2">
					<ToolButton
						label="打开故事轴"
						side="right"
						className="size-8 rounded-[7px]"
						on={kind === "spine"}
						data-page={SPINE_PAGE}
						onClick={() => open(SPINE_PAGE)}
					>
						<Table2 className="size-[17px]" />
					</ToolButton>
					<ToolButton
						label="检查"
						description="检查作品结构、引用与状态是否一致"
						disabledReason={busy ? "正在处理，请稍候" : "请先保存未保存的修改"}
						side="right"
						className="size-8 rounded-[7px]"
						disabled={busy || anyChanged}
						onClick={() =>
							act(async () => {
								const outcome = await queryClient.fetchQuery({ ...checkQuery(data.projectId), staleTime: 0 });
								// 已经在检查结果页上时页面自己会更新，再给一句话就是一屏说两遍。
								if (kind === "check") return;
								const { text, tone, details } = checkNotice(outcome);
								setNotice({
									text,
									tone,
									...(details ? { action: { label: "查看详情", page: CHECK_PAGE } } : {}),
								});
							})
						}
					>
						<ClipboardCheck className="size-[17px]" />
					</ToolButton>
					<ToolButton
						label="提交版本"
						description="将已保存的修改提交为新的作品版本"
						disabledReason={busy ? "正在处理，请稍候" : anyChanged ? "请先保存未保存的修改" : "没有可提交的修改"}
						side="right"
						className="size-8 rounded-[7px]"
						disabled={busy || anyChanged || !data.dirty}
						onClick={() =>
							act(async () => {
								const result = await invoke("project.commit", {});
								setNotice(result.created ? "已提交一个新版本" : "作品没有新的变更");
							})
						}
					>
						<GitCommitHorizontal className="size-[17px]" />
					</ToolButton>
					<div className="flex-1" />
					<ToolButton
						label="设置"
						side="right"
						className="mb-2 size-8 shrink-0"
						on={settingsOpen}
						onClick={() => setSettingsOpen(true)}
					>
						<Settings />
					</ToolButton>
				</nav>
				{showLeft && (
					<div
						id="workbench-left"
						style={{ width: leftWidth }}
						className="relative flex min-w-0 shrink-0 flex-col border-r border-line"
					>
						<PaneResizer
							side="left"
							width={leftWidth}
							max={leftMax}
							onChange={(leftWidth) => patch({ leftWidth })}
						/>
						<div
							key={view.side}
							ref={sideRef}
							className="flex min-h-0 flex-1 flex-col"
							onScrollCapture={(event) => {
								const element = event.target as HTMLElement;
								if (element.dataset.sideScroll)
									patch({
										sidePositions: {
											...view.sidePositions,
											[view.side]: { [element.dataset.sideScroll]: element.scrollTop },
										},
									});
							}}
						>
							{view.side === "files" && (
								<FilePane
									entries={directory.data?.entries ?? []}
									view={view}
									patch={patch}
									open={open}
									locate={() => locate(editPath || rawPath)}
									locatable={!!(editPath || rawPath)}
									loading={directory.isLoading}
								/>
							)}
							{view.side === "spine" && <SpinePane {...paneProps} />}
							{view.side === "ids" && <IdsPane {...paneProps} />}
							{view.side === "sources" && <SourcesPane {...paneProps} />}
							{view.side === "search" && <SearchPane {...paneProps} query={query} setQuery={setQuery} />}
						</div>
						<div className="relative flex h-11 shrink-0 items-center gap-1.5 border-t border-line pr-2.5 pl-3">
							<Popover open={libraryOpen} onOpenChange={setLibraryOpen}>
								<PopoverTrigger asChild>
									<Hint content={data.checkoutPath}>
										<button
											type="button"
											aria-label="切换作品"
											className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-control-hover"
										>
											<ChevronsUpDown className="size-[14px] shrink-0 text-muted-foreground" />
											<span className="truncate text-[13px] font-semibold">{workName}</span>
										</button>
									</Hint>
								</PopoverTrigger>
								<PopoverContent align="start" side="top" className="w-[270px] p-1.5">
									<div className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">当前作品</div>
									<div className="flex items-center justify-between rounded-md bg-hair-2 px-2 py-[7px]">
										<span className="min-w-0">
											<b className="block truncate text-[13px] font-medium">{workName}</b>
											<small className="block truncate text-[11px] text-muted-foreground">
												{data.checkoutPath} · {book.headLabel} · 正文 {textCount}/{book.order.length}
											</small>
										</span>
										<i className="shrink-0 pl-2 text-[11px] whitespace-nowrap text-primary not-italic">
											当前
										</i>
									</div>
									{recent.data?.some((item) => item.path !== data.checkoutPath) && (
										<>
											<div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">最近作品</div>
											{recent.data
												.filter((item) => item.path !== data.checkoutPath)
												.map((item) => (
													<OverflowHint content={`${item.name}\n${item.path}`} key={item.path}>
														<button
															type="button"
															className="flex w-full cursor-pointer flex-col rounded-md px-2 py-[7px] text-left hover:bg-muted disabled:opacity-50"
															disabled={busy}
															onClick={() =>
																act(async () => {
																	saveWorkspace(projectId, layoutLive.current);
																	if (await bridge().openProject(item.path)) setProjectId("");
																})
															}
														>
															<b className="block max-w-full truncate text-[13px] font-medium">
																{item.name}
															</b>
															<small className="block max-w-full truncate text-[11px] text-muted-foreground">
																{item.path}
															</small>
														</button>
													</OverflowHint>
												))}
										</>
									)}
									<Separator className="my-1.5" />
									<div className="flex gap-1">
										<Button
											variant="outline"
											size="sm"
											className="flex-1"
											disabled={busy}
											onClick={() =>
												act(async () => {
													saveWorkspace(projectId, layoutLive.current);
													if (await bridge().chooseProject(false)) setProjectId("");
												})
											}
										>
											打开作品…
										</Button>
										<Button
											variant="outline"
											size="sm"
											className="flex-1"
											disabled={busy}
											onClick={() =>
												act(async () => {
													saveWorkspace(projectId, layoutLive.current);
													if (await bridge().chooseProject(true)) setProjectId("");
												})
											}
										>
											新建作品
										</Button>
									</div>
								</PopoverContent>
							</Popover>
							<ToolButton label="帮助" side="top" on={helpOpen} onClick={() => setHelpOpen(true)}>
								<CircleHelp />
							</ToolButton>
						</div>
					</div>
				)}
				<div className={`relative min-w-0 flex-1 border-x-0! ${rightExpanded ? "hidden" : ""}`}>
					<div
						className="absolute inset-x-0 bottom-0 z-[3]"
						style={{ top: "calc(-1 * var(--workbench-header-height))" }}
					>
						<WorkspacePanes
							layout={layout}
							setLayout={setLayout}
							renderGroup={(id, first, last) => (
								<WorkspaceSurface key={id} groupId={id} first={first} last={last} />
							)}
						/>
					</div>
				</div>
				{showRight && (
					<aside
						id="workbench-right"
						style={rightExpanded ? undefined : { width: rightWidth }}
						className={`relative flex min-h-0 min-w-0 shrink-0 flex-col bg-background ${rightExpanded ? "flex-1" : "border-l border-line"}`}
					>
						{!rightExpanded && (
							<PaneResizer
								side="right"
								width={rightWidth}
								max={rightMax}
								onChange={(rightWidth) => patch({ rightWidth })}
							/>
						)}
						{view.rightMode === "back" && (
							<BacklinksPane
								title={file ? book.title(file) : book.pageTitle(page, reviews)}
								groups={backlinks}
								open={open}
								ordinal={(path) => {
									const target = book.byPath.get(path);
									return target && (target.kind === "story-beat" || target.kind === "story-text")
										? book.ordinal(target.localId)
										: Number.MAX_SAFE_INTEGER;
								}}
							/>
						)}
						{view.rightMode === "evidence" && (
							<EvidencePane book={book} reviews={reviews} file={file} content={readingContent} open={open} />
						)}
						{view.rightMode === "state" && (
							<ObservationPanel
								book={book}
								selection={view.observation}
								change={observe}
								open={open}
								allowPositionChange={!file || !(isBeat || file.kind === "story-text")}
								pendingSubject={
									file &&
									(file.kind === "character" || file.kind === "resource" || file.kind === "story-contract")
										? { kind: file.kind === "story-contract" ? "contract" : file.kind, id: file.localId }
										: undefined
								}
								reference={(text) => {
									addReference(text);
									showAgent();
								}}
							/>
						)}
						{view.rightMode === "agent" && (
							<AgentPanel
								book={book}
								sessions={data.sessions}
								selected={conversation?.id ?? view.sessionId}
								onSelect={(id) => patch({ sessionId: id, sessionChosen: true })}
								key={`${book.data.projectId}:${draftKey}`}
								composer={composer}
								draftKey={draftKey}
								updateComposer={updateComposer}
								onSubmitted={onSubmitted}
								readReference={readReference}
								completeAttachment={completeAttachment}
								currentPath={["artifact", "file"].includes(kind) && primary.data ? editPath : ""}
								currentSelection={selectedText}
								isCurrentProject={isCurrentProject}
								position={view.conversationPositions[draftKey]}
								onPosition={(position) => savePosition(draftKey, position)}
								refresh={refresh}
								open={open}
								openSettings={() => setSettingsOpen(true)}
								expanded={view.expanded}
								toggleExpand={() => patch({ expanded: !view.expanded })}
							/>
						)}
					</aside>
				)}
			</div>

			<HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
			<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
				<DialogContent className="flex h-[min(82vh,680px)] max-w-[880px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]">
					<DialogHeader className="border-b border-hair px-6 py-4 text-left">
						<DialogTitle className="text-base">设置</DialogTitle>
						<DialogDescription className="sr-only">
							配置模型与提供商；保存偏好不改变正在执行的回复。
						</DialogDescription>
					</DialogHeader>
					<ModelSettings />
				</DialogContent>
			</Dialog>
		</NavigationSurface>
	);
}
