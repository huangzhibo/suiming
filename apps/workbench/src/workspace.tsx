import {
	CircleHelp,
	ClipboardCheck,
	Clock,
	GitCommitHorizontal,
	Link2,
	MessageSquare,
	PanelLeft,
	PanelRight,
	ScrollText,
	Settings,
	Table2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentPanel } from "./agent-panel.js";
import { bridge, invoke } from "./bridge.js";
import { checkQuery } from "./check-page.js";
import { checkNotice } from "./check-result.js";
import { DocumentGroup } from "./document-group.js";
import { FilePane } from "./file-pane.js";
import { HelpDialog } from "./help.js";
import { IdsPane, SearchPane, SourcesPane, SpinePane } from "./left-pane.js";
import { backlinksFor, CHECK_PAGE, SPINE_PAGE } from "./model.js";
import { ModelSettings } from "./model-settings.js";
import { NavigationModes } from "./navigation-modes.js";
import { NavigationSurface } from "./navigation-surface.js";
import { ObservationPanel } from "./observation-panel.js";
import { PaneResizer } from "./pane-resizer.js";
import { ProjectSwitcher } from "./project-switcher.js";
import { BacklinksPane, EvidencePane } from "./right-pane.js";
import { useAutoHideScrollbars } from "./scrollbars.js";
import { ToolButton } from "./ui-bits.js";
import { useComposerWorkspace } from "./use-composer-workspace.js";
import { useWorkspaceGroup } from "./use-workspace-group.js";
import { createTab, EMPTY_PAGE, type ObservationSelection, pageState, type RightMode } from "./view-state.js";
import { LoadingScreen, WelcomeScreen } from "./welcome-screen.js";
import { type Notice, useWorkspace, WorkspaceContext } from "./workspace-context.js";
import {
	groupView,
	loadWorkspace,
	resolveWorkspaceDocuments,
	saveWorkspace,
	updateGroup,
	workspaceLayout,
	workspaceScreen,
} from "./workspace-layout.js";
import { WorkspacePanes } from "./workspace-panes.js";

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
			<WorkspaceShell />
		</WorkspaceContext>
	);
}

/** 工作台外壳：标题栏、全局动作、左右栏与设置；中间的文档区按分屏布局画出各个 DocumentGroup。 */
function WorkspaceShell() {
	const {
		layout,
		setLayout,
		projectId,
		setProjectId,
		setPanePriority,
		settingsOpen,
		setSettingsOpen,
		helpOpen,
		setHelpOpen,
		error,
		setError,
		setNotice,
		busy,
		composerActions,
	} = useWorkspace();
	const { updateComposer, onSubmitted, completeAttachment, isCurrentProject, savePosition } = composerActions;
	const [libraryOpen, setLibraryOpen] = useState(false);
	const {
		layoutLive,
		live,
		view,
		patch,
		selectedText,
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
		page,
		kind,
		rawPath,
		file,
		isBeat,
		editPath,
		primary,
		buffer,
		anyChanged,
		act,
		open,
		showAgent,
		observe,
		locate,
	} = useWorkspaceGroup(undefined, { onOpen: () => setLibraryOpen(false) });
	const query = view.searchQuery;
	const setQuery = (searchQuery: string) => patch({ searchQuery });
	useEffect(() => {
		if (!window.suiming) return;
		return bridge().onChange((changes) => {
			if (changes.includes("workspace")) refresh();
			else if (changes.includes("execution")) {
				for (const key of ["session-list", "tasks", "inbox"])
					void queryClient.invalidateQueries({ queryKey: [key] });
			}
		});
	}, [refresh, queryClient]);
	// 项目恢复保留缺失页面与草稿；作品解析失败时仍可进入文件树。
	useEffect(() => {
		if (!shown || projectId === shown.projectId) return;
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
	}, [shown, projectId, book, projection.isError, setLayout, setProjectId]);
	useEffect(() => {
		if (!book || projectId !== book.data.projectId) return;
		setLayout((current) => resolveWorkspaceDocuments(current, book));
	}, [book, projectId, setLayout]);
	useEffect(() => {
		if (!projectId || projectId !== shown?.projectId) return;
		try {
			saveWorkspace(projectId, layout);
		} catch {
			setError("本机草稿存储空间不足，请保存当前编辑后再关闭窗口。");
		}
	}, [layout, projectId, shown?.projectId, setError]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: live / layoutLive 是 useWorkspaceGroup 给的 ref，读的是事件发生那一刻的值，不该让 effect 随它重跑
	useEffect(() => {
		if (!projectId) return;
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
	}, [projectId]);
	const sideRef = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: live / layoutLive 是 useWorkspaceGroup 给的 ref，读的是事件发生那一刻的值，不该让 effect 随它重跑
	useEffect(() => {
		if (!showLeft) return;
		for (const element of sideRef.current?.querySelectorAll<HTMLElement>("[data-side-scroll]") ?? [])
			element.scrollTop = live.current.sidePositions[view.side]?.[element.dataset.sideScroll ?? ""] ?? 0;
	}, [view.side, showLeft]);

	// 加载中给一个安静的加载态，只有确实没有作品才请作者打开或新建（判定见 workspaceScreen）。
	const surface = workspaceScreen({ show: projection.status, files: directory.status });
	if (surface === "loading") return <LoadingScreen />;
	if (surface === "welcome" || !shown || !book)
		return (
			<WelcomeScreen
				error={error || projection.error?.message}
				onChoose={(create) =>
					act(async () => {
						await bridge().chooseProject(create);
					})
				}
			/>
		);

	const data = shown;
	const backlinks = file ? backlinksFor(book, file.path) : [];
	const readingContent = buffer;
	const textCount = book.order.filter((id) => book.text(id)).length;
	const workName = data.checkoutPath.split("/").at(-1) ?? "作品";
	const rightButton = (mode: RightMode, label: string, icon: React.ReactNode) => (
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
		</ToolButton>
	);
	const paneProps = { book, reviews, view, page, patch, open };
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
					// 盖在标签栏的左外边距上，并多盖一像素画出底边线：那一段标签栏没有自己的底边。
					<div
						data-side-toggle="left"
						className="relative z-[5] -mb-px flex w-(--side-toggle-width) shrink-0 items-center border-b border-line bg-titlebar pr-1.5 pl-(--window-controls-inset)"
					>
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
						{rightButton("agent", "对话", <MessageSquare />)}
						<span className="flex-1" />
						<ToolButton label="收起右栏" onClick={() => patch({ right: false, expanded: false })}>
							<PanelRight />
						</ToolButton>
					</div>
				) : (
					<div
						data-side-toggle="right"
						className="relative z-[5] -mb-px flex w-11 shrink-0 items-center border-b border-line bg-titlebar px-2"
					>
						<ToolButton
							label="展开右栏"
							onClick={() => {
								setPanePriority("right");
								patch({ right: true });
							}}
						>
							<PanelRight />
						</ToolButton>
					</div>
				)}
			</div>
			<div className="flex min-h-0 flex-1 divide-x divide-line">
				{/* 左栏收起后动作栏改用正文的白底，与主工作面连成一片；展开时随左栏是浅灰。 */}
				<nav
					aria-label="全局动作"
					className={`flex w-11 shrink-0 flex-col items-center gap-2 py-2 ${showLeft ? "" : "bg-background"}`}
				>
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
							<ProjectSwitcher
								open={libraryOpen}
								onOpenChange={setLibraryOpen}
								workName={workName}
								checkoutPath={data.checkoutPath}
								detail={`${book.headLabel} · 正文 ${textCount}/${book.order.length}`}
								recent={recent.data}
								busy={busy}
								onSwitch={(choose) =>
									act(async () => {
										saveWorkspace(projectId, layoutLive.current);
										if (await choose()) setProjectId("");
									})
								}
							/>
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
								<DocumentGroup key={id} groupId={id} first={first} last={last} />
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
			{/* 设置像 Obsidian 一样是模态框：不占标签页，关掉就回到原来的工作面。 */}
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
