import { X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StoryAxis } from "./axis/StoryAxis.js";
import { invoke } from "./bridge.js";
import { CheckPage } from "./check-page.js";
import type { ComparisonController, ComparisonStatus } from "./code-editor.js";
import { ComparisonActions, ComparisonBaseline, ComparisonOptions } from "./comparison-controls.js";
import { DocumentToolbar } from "./document-toolbar.js";
import { EmptyPage } from "./empty-page.js";
import { Markdown } from "./markdown.js";
import { CANDIDATE_VERSION, pageTarget, stripFrontmatter, textPathFor } from "./model.js";
import { NavigationSurface } from "./navigation-surface.js";
import { ArtifactPage, IssuePage, VersionPage } from "./pages.js";
import { captureReadingSelection, restoreReadingSelection } from "./reading-selection.js";
import { SelectionBar } from "./selection-bar.js";
import { TabStrip } from "./tab-strip.js";
import { Hint } from "./ui-bits.js";
import { UnsavedChangesDialog } from "./unsaved-changes-dialog.js";
import { useWorkspaceGroup } from "./use-workspace-group.js";
import {
	EMPTY_PAGE,
	historyMove,
	type PageState,
	pageState,
	patchView,
	resolveComparisonLayout,
	resolveOpening,
	savedDocument,
} from "./view-state.js";
import { useWorkspace } from "./workspace-context.js";
import {
	closeWorkspaceTab,
	groupView,
	mergeGroup,
	openComparison,
	splitGroup,
	updateGroup,
} from "./workspace-layout.js";

const CodeEditor = lazy(() => import("./code-editor.js"));

/** 一个文档窗格：标签栏、文档区，以及关闭有未保存修改的标签时的确认框。分屏时每格一个。 */
export function DocumentGroup({ groupId, first, last }: { groupId: string; first: boolean; last: boolean }) {
	const {
		layout,
		setLayout,
		settingsOpen,
		helpOpen,
		setHelpOpen,
		setPanePriority,
		error,
		setError,
		notice,
		setNotice,
		busy,
	} = useWorkspace();
	const {
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
		queryClient,
		projection,
		directory,
		shown,
		reviews,
		reviewsLoading,
		book,
		refresh,
		showLeft,
		showRight,
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
	} = useWorkspaceGroup(groupId);
	const [closeRequest, setCloseRequest] = useState<{ tabId?: string; paths: string[] } | null>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const mainRef = useRef<HTMLElement>(null);

	const comparisonController = useRef<ComparisonController | null>(null);
	const [comparisonStatus, setComparisonStatus] = useState<ComparisonStatus | null>(null);
	const [comparisonWidth, setComparisonWidth] = useState(window.innerWidth);
	useEffect(() => {
		if (kind !== "diff" || !mainRef.current) return;
		const observer = new ResizeObserver(([entry]) => setComparisonWidth(entry?.contentRect.width ?? 0));
		observer.observe(mainRef.current);
		return () => observer.disconnect();
	}, [kind]);
	const comparisonLayout = resolveComparisonLayout(view.diffLayout, comparisonWidth);
	useEffect(() => {
		if (!tab || !isBeat || !view.resolveContent || !secondary.isSuccess || secondary.isFetching) return;
		const content = state.documents[textPath]?.content ?? secondary.data.content;
		setView((current) => resolveOpening(current, tab.id, stripFrontmatter(content).trim().length > 0));
	}, [
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
	const restoredFor = useRef("");
	const restoreKey = `${tab?.id}:${page}:${view.beatView}:${view.edit}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: live / layoutLive 是 useWorkspaceGroup 给的 ref，读的是事件发生那一刻的值，不该让 effect 随它重跑
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

	// 外壳只在作品读到之后才画出各窗格，这里只是让类型收窄。
	if (!shown || !book) return null;
	const data = shown;
	const report = kind === "issue" ? reviews.find((item) => item.id === pageTarget(page)) : undefined;
	const textCount = book.order.filter((id) => book.text(id)).length;
	const dirtyCount = data.files.filter((item) => item.dirty).length;
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
								original={comparisonOriginal}
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
								{reviewsLoading ? "正在读取审稿报告…" : "找不到这份审稿报告"}
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
			<SelectionBar
				visible={kind === "artifact"}
				selectedText={selectedText}
				selPara={selPara}
				source={`${book.title(file)} · ${book.headLabel}`}
				path={editPath}
				revisionId={data.revisionId}
				contentSHA={saved.sha256}
				setSelectedText={setSelectedText}
				setSelPara={setSelPara}
				composer={composer}
				draftKey={draftKey}
				conversation={conversation}
				addReference={addReference}
				showAgent={showAgent}
				refresh={refresh}
			/>
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
				onPointerDownCapture={() => setLayout((v) => (v.activeGroup === group ? v : { ...v, activeGroup: group }))}
				onFocusCapture={() => setLayout((v) => (v.activeGroup === group ? v : { ...v, activeGroup: group }))}
			>
				<TabStrip
					tabs={view.tabs}
					active={view.active}
					book={book}
					reviews={reviews}
					insetLeft={first && !showLeft}
					insetRight={last && !showRight}
					unsaved={(location) => protectedLocation(location, state)}
					onActivate={activate}
					onClose={closeTab}
					onTogglePin={(id) =>
						setView((v) => ({
							...v,
							tabs: v.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
						}))
					}
					onDuplicate={(location) => open(location.page, location, { newTab: true })}
					onNewTab={newTab}
				/>
				{documentPane}
			</section>
			<UnsavedChangesDialog
				paths={closeRequest?.paths}
				busy={busy}
				error={error}
				onCancel={() => setCloseRequest(null)}
				onDiscard={() => {
					discard(closeRequest?.paths ?? []);
					finishClose();
				}}
				onSave={() =>
					act(async () => {
						for (const path of closeRequest?.paths ?? []) await savePath(path);
						finishClose();
					})
				}
			/>
		</NavigationSurface>
	);
}
