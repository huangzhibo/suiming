import type { LocalCommandOutput } from "@suiming/sdk";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { anchorParagraphs } from "./anchors.js";
import { propertyRows } from "./artifact-properties.js";
import { axisModel } from "./axis/layout.js";
import { CharacterTrack, ContractTrack } from "./axis/MiniTrack.js";
import { NeighborhoodView } from "./axis/NeighborhoodView.js";
import { invoke } from "./bridge.js";
import { Markdown } from "./markdown.js";
import {
	type Book,
	CANDIDATE_TITLE,
	codePoints,
	type FileEntry,
	issuePage,
	KIND_LABEL,
	type ReviewReport,
	reviewsFor,
	shortId,
	stripFrontmatter,
	versionPage,
} from "./model.js";
import { verdictLabel, verdictTone } from "./review-verdict.js";
import { ActionButton, reviewCurrencyLabel, reviewLayerLabel, Tag, toneText } from "./ui-bits.js";
import type { OpenPage, PageState } from "./view-state.js";

const CodeEditor = lazy(() => import("./code-editor.js"));

function Props({ book, file, open }: { book: Book; file: FileEntry; open(page: string): void }) {
	const rows = propertyRows(book, file);
	if (!rows.length) return null;
	return (
		<details className="properties mb-6" data-properties open key={file.path}>
			<summary className="navigation-link -ml-1.5 mb-1 flex w-fit items-center gap-1.5 text-[13px] font-medium text-sub [&::-webkit-details-marker]:hidden">
				<ChevronDown className="size-3.5" aria-hidden="true" />
				属性
			</summary>
			<dl aria-label="属性">
				{rows.map((row) => (
					<div className="props-row" key={row.key}>
						<dt className="min-w-0 text-muted-foreground">{row.label}</dt>
						<dd className={row.multiline ? "property-lines" : "property-values"}>
							{row.values.map((value, index) =>
								value.path ? (
									<button
										type="button"
										// biome-ignore lint/suspicious/noArrayIndexKey: 只读字段数组允许重复值，序号区分源文件中的不同项。
										key={`${index}:${value.path}`}
										className="navigation-link property-link"
										data-page={value.path}
										onClick={() => value.path && open(value.path)}
									>
										{value.text}
									</button>
								) : (
									<span
										className="property-text"
										// biome-ignore lint/suspicious/noArrayIndexKey: 只读字段数组允许重复值，序号区分源文件中的不同项。
										key={`${index}:${value.text}`}
									>
										{value.text}
									</span>
								),
							)}
						</dd>
					</div>
				))}
			</dl>
		</details>
	);
}

/** 设计 / 人物 / 世界 / Intent / Contract 的正文：Markdown 渲染，frontmatter 已由属性表展示。 */
function Body({ content }: { content: string }) {
	const body = stripFrontmatter(content).trim();
	if (!body) return <p className="design-body text-muted-foreground">这个文件还没有正文。</p>;
	return <Markdown className="design-body" content={body} />;
}

/** 正文：宋体连续阅读；段落带 data-index，选择由 selectionchange 判定所在段。 */
export function Prose({
	content,
	selected,
	compact = false,
	marks,
}: {
	content: string;
	selected: number;
	compact?: boolean;
	marks?: ReadonlyMap<number, string>;
}) {
	return (
		<Markdown
			className={`prose-text ${compact ? "prose-compact" : ""} font-serif text-ink-2`}
			data-prose
			content={stripFrontmatter(content)}
			selected={selected}
			{...(marks === undefined ? {} : { marks })}
		/>
	);
}

/** 当前有效的报告里锚到这份正文的 finding，按段号汇总标题；报告 stale 时不标，段号已对不上。 */
export function findingMarks(reports: ReviewReport[], textPath: string, content: string): Map<number, string> {
	const marks = new Map<number, string>();
	const body = stripFrontmatter(content);
	for (const report of reports) {
		if (!report.current) continue;
		for (const finding of report.findings) {
			if (!finding.paths.includes(textPath)) continue;
			for (const index of anchorParagraphs(finding.evidence, body))
				marks.set(index, marks.has(index) ? `${marks.get(index)}；${finding.title}` : finding.title);
		}
	}
	return marks;
}

export interface ArtifactPageProps {
	book: Book;
	reviews: ReviewReport[];
	file: FileEntry;
	content: string;
	/** StoryBeat 的正文文件与内容；不存在时 content 为空串。 */
	text?: { file: FileEntry | undefined; content: string };
	view: "design" | "text";
	selected: number;
	open(page: string): void;
	delegateWrite(): void;
	openEditor(): void;
}
/** 正文页只展示阅读内容；设计与对象页补充属性、轨迹和邻域图。 */
export function ArtifactPage(props: ArtifactPageProps) {
	const { book, reviews, file, content, text, view, selected, open } = props;
	const isBeat = file.kind === "story-beat";
	const isText = file.kind === "story-text";
	const beatId = isBeat || isText ? file.localId : undefined;
	const showText = isText || (isBeat && view === "text");
	const displayFile = showText ? (isText ? file : text?.file) : file;
	const textContent = isText ? content : (text?.content ?? "");
	const hasText = stripFrontmatter(textContent).trim().length > 0;
	const reports = reviewsFor(book, reviews, file.path);
	const latest = reports.at(-1);
	const textPath = beatId ? `text/${beatId}.md` : file.path;
	const marks = useMemo(() => findingMarks(reports, textPath, textContent), [reports, textPath, textContent]);
	const bound = beatId ? book.currencyLabel(beatId) : undefined;
	const lineage = isBeat || isText ? (hasText ? (bound?.text ?? "") : "尚无正文") : "";
	// 承诺页 / 人物页 / Beat 页顶部的轨迹与前因后果都取自故事轴同一份模型。
	const axis = useMemo(() => axisModel(book, reviews), [book, reviews]);
	const contractLane =
		file.kind === "story-contract" ? axis.contracts.find((lane) => lane.path === file.path) : undefined;
	const characterLane =
		file.kind === "character" ? axis.characters.find((lane) => lane.path === file.path) : undefined;
	const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set());
	const status: { text: string; color: string }[] = [
		{
			text: `${codePoints(stripFrontmatter(showText ? textContent : content)).toLocaleString()} 字`,
			color: "text-muted-foreground",
		},
		(showText || !hasText) && lineage
			? {
					text: lineage,
					color: hasText ? toneText(bound?.tone) : "text-muted-foreground",
				}
			: undefined,
		displayFile?.dirty ? { text: "未提交", color: "text-amber" } : undefined,
	].filter((item): item is { text: string; color: string } => !!item);
	return (
		<article className="document-page" data-measure={showText ? "reading" : "document"}>
			<h1 className="mb-1 text-[26px] leading-[1.4] font-semibold tracking-[.5px]">
				{isText ? book.beatTitle(file.localId) : book.title(file)}
			</h1>
			<div className="mb-[22px] flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
				{!showText && <span>{KIND_LABEL[file.kind] ?? file.kind}</span>}
				{status.map((item, index) => (
					<span key={item.text} className="contents">
						{(!showText || index > 0) && <span className="text-faint">·</span>}
						<span className={item.color}>{item.text}</span>
					</span>
				))}
			</div>
			{contractLane && <ContractTrack model={axis} lane={contractLane} open={open} />}
			{characterLane && <CharacterTrack model={axis} lane={characterLane} open={open} />}
			{!showText && <Props book={book} file={file} open={open} />}
			{!showText && <Body content={content} />}
			{showText &&
				(hasText ? (
					<>
						{latest && (
							<div
								className={`mb-[18px] flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs leading-normal text-ink-3 ${latest.current && latest.verdict === "pass" ? "bg-background" : "border-amber-line bg-amber-bg"}`}
							>
								<b
									className={`font-semibold whitespace-nowrap ${latest.current && latest.verdict === "pass" ? "text-success" : "text-amber-ink"}`}
								>
									审稿
								</b>
								<span className="flex-1">
									{latest.findings.length} 条审稿意见 · {verdictLabel(latest.verdict)} ·{" "}
									{reviewCurrencyLabel(latest.current)}
								</span>
								<Button
									variant="link"
									size="xs"
									className="h-auto p-0"
									data-page={issuePage(latest.id)}
									onClick={() => open(issuePage(latest.id))}
								>
									查看 →
								</Button>
							</div>
						)}
						<Prose content={textContent} selected={selected} marks={marks} />
					</>
				) : (
					<NoText delegateWrite={props.delegateWrite} openEditor={props.openEditor} />
				))}
			{/* 邻域图辅助理解设计结构，不接在小说正文后；承诺页顶部已有完整轨迹。 */}
			{!showText && !contractLane && (
				<section className="mt-9 border-t border-hair pt-3.5" data-relations>
					<h2 className="mb-1 text-[11.5px] text-muted-foreground">关系</h2>
					<NeighborhoodView
						book={book}
						path={file.path}
						open={open}
						expandedKinds={expandedKinds}
						onExpand={(kind) => setExpandedKinds(new Set([...expandedKinds, kind]))}
					/>
				</section>
			)}
		</article>
	);
}
function NoText({ delegateWrite, openEditor }: { delegateWrite(): void; openEditor(): void }) {
	return (
		<div className="rounded-lg border border-dashed border-[#d4d4d8] px-5 py-[18px] text-[12.5px] leading-[1.7] text-muted-foreground">
			正文尚未开始。可以先完善设计，也可以从这里开始写作。
			<div className="mt-2.5 flex gap-1.5">
				<Button size="sm" onClick={delegateWrite}>
					请 Agent 写正文
				</Button>
				<Button size="sm" variant="outline" onClick={openEditor}>
					自己开始写
				</Button>
			</div>
		</div>
	);
}

export function IssuePage({
	book,
	report,
	open,
	openInText,
	sendToAgent,
	selection,
	onSelection,
	scrolls,
}: {
	book: Book;
	report: ReviewReport;
	open(page: string): void;
	openInText(path: string): void;
	selection: PageState["review"];
	onSelection(value: PageState["review"]): void;
	scrolls: PageState["scrolls"];
	sendToAgent(text: string): void;
}) {
	const anchor = selection.anchor || report.findings.find((f) => f.paths[0])?.paths[0] || report.paths[0] || "";
	// 审稿看的是 revision R 下的稿：版本不可变，读到一次就够。
	const reviewed = useQuery({
		queryKey: ["file", anchor, report.revision],
		queryFn: () => invoke("workspace.file.read", { path: anchor, revisionId: report.revision }),
		enabled: !!anchor,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const active = selection.active;
	const setAnchor = (anchor: string) => onSelection({ ...selection, anchor });
	const current = useQuery({
		queryKey: ["file", anchor],
		queryFn: () => invoke("workspace.file.read", { path: anchor }),
		enabled: !!anchor,
	});
	const subject = report.paths.map((path) => book.title(book.byPath.get(path)) || path).join("、");
	const body = stripFrontmatter(current.data?.content ?? "");
	// 每条 finding 在当前稿里锚到的段号；报告 stale 时段号可能已错位，仍然标出但由标题提示。
	const anchored = useMemo(
		() =>
			report.findings.map((finding) =>
				finding.paths.includes(anchor) ? anchorParagraphs(finding.evidence, body) : [],
			),
		[report.findings, anchor, body],
	);
	const marks = useMemo(() => {
		const map = new Map<number, string>();
		anchored.forEach((indexes, findingIndex) => {
			if (active >= 0 && active !== findingIndex) return;
			const title = report.findings[findingIndex]?.title ?? "";
			for (const index of indexes) map.set(index, map.has(index) ? `${map.get(index)}；${title}` : title);
		});
		return map;
	}, [anchored, active, report.findings]);
	// 选中一条 finding 后把它的第一段滚进视野。
	useEffect(() => {
		if (active < 0 || marks.size === 0) return;
		document.querySelector(".issue-current p[data-mark='true']")?.scrollIntoView({ block: "center" });
	}, [active, marks]);
	const root = useRef<HTMLDivElement>(null);
	const restored = useRef(false);
	useEffect(() => {
		if (restored.current || reviewed.isLoading || current.isLoading) return;
		const frame = requestAnimationFrame(() => {
			for (const element of root.current?.querySelectorAll<HTMLElement>("[data-scroll-key]") ?? []) {
				const saved = scrolls[element.dataset.scrollKey ?? ""];
				if (saved) {
					element.scrollTop = saved.top;
					element.scrollLeft = saved.left;
				}
			}
			restored.current = true;
		});
		return () => cancelAnimationFrame(frame);
	}, [reviewed.isLoading, current.isLoading, scrolls]);
	const paragraphLabel = (indexes: number[]) => indexes.map((index) => `第 ${index + 1} 段`).join("、");
	return (
		<div ref={root} className="flex min-h-0 flex-1 flex-col">
			<section
				data-scroll-key="review-findings"
				aria-label="审稿结论与问题"
				className="max-h-[45%] shrink-0 overflow-auto border-b border-hair-2 px-5 py-3"
			>
				<div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
					<Tag tone={verdictTone(report.verdict)}>{verdictLabel(report.verdict)}</Tag>
					{report.paths[0] && (
						<Button
							variant="link"
							size="xs"
							className="h-auto p-0"
							data-page={report.paths[0] ?? ""}
							onClick={() => open(report.paths[0] ?? "")}
						>
							{subject}
						</Button>
					)}
					<span className={report.current ? "text-primary" : "text-amber"}>
						{reviewCurrencyLabel(report.current)}
					</span>
					<span className="flex-1" />
					<span className="text-[11.5px] text-muted-foreground">
						{reviewLayerLabel(report.layer)}审稿 {shortId(report.id)} · 审的是{" "}
						{book.revisionLabel(report.revision)}
					</span>
				</div>
				<h1 className="mb-2 text-base font-semibold">审稿报告 · {report.findings.length} 条问题</h1>
				<p className="mb-3 text-[12.5px] leading-[1.7] whitespace-pre-wrap text-ink-3">{report.summary}</p>
				{report.findings.map((finding, findingIndex) => {
					const indexes = anchored[findingIndex] ?? [];
					return (
						<div
							className="border-t border-hair-2 py-2.5 data-[on=true]:bg-amber-bg/60"
							data-on={active === findingIndex}
							key={`${finding.title}:${finding.paths.join(";")}`}
						>
							<button
								type="button"
								className="mb-1 flex cursor-pointer items-center gap-2 text-left text-[13.5px] font-semibold"
								aria-pressed={active === findingIndex}
								onClick={() => {
									onSelection({
										...selection,
										active: active === findingIndex ? -1 : findingIndex,
										anchor: finding.paths[0] ?? anchor,
									});
								}}
							>
								{finding.title}
								{indexes.length > 0 && (
									<Tag tone="amber" className="font-medium">
										{paragraphLabel(indexes)}
									</Tag>
								)}
							</button>
							<p className="mb-0.5 text-[12.5px] leading-[1.7] whitespace-pre-wrap text-ink-3">
								{finding.evidence.trim()}
							</p>
							{finding.suggestion.trim() && (
								<p className="mb-1.5 text-[12.5px] leading-[1.7] whitespace-pre-wrap text-ink-3">
									<span className="text-muted-foreground">建议 · </span>
									{finding.suggestion.trim()}
								</p>
							)}
							<div className="flex flex-wrap gap-1.5">
								{finding.paths.map((path) => (
									<Button
										variant="outline"
										size="xs"
										key={path}
										data-page={path}
										onClick={() => {
											setAnchor(path);
											openInText(path);
										}}
									>
										在正文中打开 · {path.split("/").at(-1)}
									</Button>
								))}
								<Button
									variant="outline"
									size="xs"
									onClick={() =>
										sendToAgent(
											`请复核这条审稿意见的修复是否充分：${finding.title}${indexes.length > 0 ? `（${anchor} ${paragraphLabel(indexes)}）` : ""}\n${finding.evidence}${finding.suggestion ? `\n建议：${finding.suggestion}` : ""}`,
										)
									}
								>
									复核这条意见
								</Button>
							</div>
						</div>
					);
				})}
				{report.findings.length === 0 && (
					<p className="text-[11.5px] text-muted-foreground">没有意见：审稿人判断被审内容成立。</p>
				)}
			</section>
			<div className="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
				<div data-scroll-key="review-evidence" className="min-w-0 overflow-auto border-r border-hair px-5 py-3">
					<div className="mb-2.5 flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground">
						<span>被审的稿 · {book.revisionLabel(report.revision)}</span>
						<span>{anchor || "—"}</span>
					</div>
					{reviewed.data ? (
						<pre className="evidence-text">{stripFrontmatter(reviewed.data.content)}</pre>
					) : (
						<p className="text-[11.5px] text-muted-foreground">
							{reviewed.error
								? reviewed.error.message
								: anchor
									? "正在读取被审的稿…"
									: "这份审稿没有指向具体文件"}
						</p>
					)}
				</div>
				<div data-scroll-key="review-current" className="issue-current min-w-0 overflow-auto px-5 py-3">
					<div className="mb-2.5 flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground">
						<span>当前稿 · {anchor || "—"}</span>
						{/* 是否对应当前稿已在顶部说过；这里只在过时时补一句段号的后果。 */}
						{!report.current && <span className="text-amber">段号可能已错位</span>}
					</div>
					{current.data ? (
						body ? (
							<Prose content={body} selected={-1} compact marks={marks} />
						) : (
							<p className="text-[11.5px] text-muted-foreground">（当前没有内容）</p>
						)
					) : (
						<p className="text-[11.5px] text-muted-foreground">
							{anchor ? "正在读取…" : "这份报告没有指向具体文件"}
						</p>
					)}
				</div>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t px-5 py-2 text-[11.5px] text-muted-foreground">
				<Button
					size="sm"
					onClick={() =>
						sendToAgent(`请复核审稿 ${report.id}（${verdictLabel(report.verdict)}）：${report.summary}`)
					}
				>
					复核整份审稿
				</Button>
			</div>
		</div>
	);
}

/** 版本页：某个 ProjectRevision 相对父版本的差分，或候选相对当前版本。 */
export function VersionPage({
	book,
	revisionId,
	open,
	selected,
	onSelect: setSelected,
	positions,
	positionChange,
}: {
	book: Book;
	revisionId: string;
	open: OpenPage;
	selected: string;
	onSelect(path: string): void;
	positions: PageState["editors"];
	positionChange(path: string, position: PageState["editors"][string]): void;
}) {
	// 版本页有两种目标：具体 revision，或 checkout 里尚未提交的候选（作者与 Agent 共用同一份）。
	const candidate = revisionId === "candidate";
	const [confirming, setConfirming] = useState(false);
	const [rolling, setRolling] = useState(false);
	const [rollbackNote, setRollbackNote] = useState<{ text: string; failed: boolean } | null>(null);
	const isHead = revisionId === book.data.revisionId;
	async function rollback() {
		setRolling(true);
		setRollbackNote(null);
		try {
			const result = await invoke("project.rollback", { revisionId });
			setConfirming(false);
			setRollbackNote({
				text: result.created ? "已恢复为新版本" : "内容与当前版本相同，没有新建版本",
				failed: false,
			});
			if (result.created) open(versionPage(result.revision.id));
		} catch (error) {
			setRollbackNote({ text: error instanceof Error ? error.message : String(error), failed: true });
		} finally {
			setRolling(false);
		}
	}
	const diff = useQuery({
		queryKey: ["diff", revisionId],
		queryFn: () => (candidate ? invoke("project.diff", {}) : invoke("revision.diff", { revisionId })),
		retry: false,
	});
	const entry = selected ? diff.data?.find((item) => item.path === selected) : diff.data?.[0];
	const revision = book.data.revisions.find((revision) => revision.id === revisionId);
	// 清单只有路径与增删改；选中的这一个文件再读两侧。未提交的修改是「当前版本 → 作品目录」，
	// 历史版本是「父版本 → 这个版本」，第一个版本之前是空作品。
	const beforeRevision = candidate ? book.data.revisionId : (revision?.parentId ?? null);
	const sides = useQuery({
		queryKey: ["diff", revisionId, "file", entry?.path, beforeRevision],
		queryFn: async () => {
			const path = entry?.path ?? "";
			const side = async (read: Promise<LocalCommandOutput<"workspace.file.read">>) => {
				const view = await read;
				return view.textual ? view.content : `[二进制文件 ${view.size} bytes · ${view.sha256 ?? ""}]`;
			};
			const [before, after] = await Promise.all([
				beforeRevision === null ? "" : side(invoke("workspace.file.read", { path, revisionId: beforeRevision })),
				side(invoke("workspace.file.read", candidate ? { path } : { path, revisionId })),
			]);
			return { path, before, after };
		},
		enabled: !!entry,
		retry: false,
	});
	const label = candidate ? CANDIDATE_TITLE : book.revisionLabel(revisionId);
	const previous = candidate ? book.headLabel : revision?.parentId ? book.revisionLabel(revision.parentId) : "空作品";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 px-7 pt-[22px]">
				<div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button size="xs" variant="outline" aria-label="选择作品版本">
								{label}
								<ChevronDown data-icon="inline-end" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuRadioGroup
								value={revisionId}
								onValueChange={(id) => open(versionPage(id), { versionFile: selected })}
							>
								{book.data.revisions.map((item) => (
									<DropdownMenuRadioItem key={item.id} value={item.id}>
										{book.revisionLabel(item.id)} · {shortId(item.id)}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<span>{candidate ? `相对 ${previous}` : `${shortId(revisionId)} · 父版本 ${previous}`}</span>
					<span className="flex-1" />
					<span>{diff.data ? `${diff.data.length} 个文件变更` : ""}</span>
					{!candidate && !isHead && !confirming && (
						<ActionButton
							variant="outline"
							size="xs"
							disabledReason={book.data.dirty ? "有未提交的修改：先提交或放弃，再恢复历史版本" : undefined}
							onClick={() => setConfirming(true)}
						>
							恢复为新版本
						</ActionButton>
					)}
					{confirming && (
						<>
							<span className="text-amber">把 {label} 的内容作为当前版本的新子版本提交，历史不倒拨。</span>
							<Button size="xs" disabled={rolling} onClick={() => void rollback()}>
								确认恢复
							</Button>
							<Button variant="outline" size="xs" disabled={rolling} onClick={() => setConfirming(false)}>
								取消
							</Button>
						</>
					)}
					{rollbackNote && (
						<span className={rollbackNote.failed ? "text-destructive" : "text-success"}>{rollbackNote.text}</span>
					)}
				</div>
				<h1 className="mb-3.5 text-lg font-semibold">{candidate ? CANDIDATE_TITLE : `版本 ${label}`}</h1>
			</div>
			<div className="flex shrink-0 gap-1.5 overflow-auto px-7 pb-3">
				{diff.data?.map((item) => (
					<Button
						variant="outline"
						size="xs"
						key={item.path}
						className={entry?.path === item.path ? "border-primary-line bg-primary-soft" : ""}
						onClick={() => setSelected(item.path)}
					>
						{item.kind === "added" ? "+ " : item.kind === "deleted" ? "− " : ""}
						{item.path}
					</Button>
				))}
			</div>
			{entry ? (
				<>
					<div className="grid shrink-0 grid-cols-2 border-t border-b border-hair bg-[#fafafa] text-[11px] text-muted-foreground">
						<span className="px-7 py-1.5">之前 · {previous}</span>
						<span className="border-l border-hair px-7 py-1.5">之后 · {label}</span>
					</div>
					<div className="min-h-0 flex-1">
						{sides.error ? (
							<p role="alert" className="p-5 text-[11.5px] text-destructive">
								{sides.error.message}
							</p>
						) : sides.data?.path !== entry.path ? (
							<p className="p-5 text-[11.5px] text-muted-foreground">正在计算差异…</p>
						) : (
							<Suspense fallback={<p className="p-5 text-[11.5px] text-muted-foreground">正在计算差异…</p>}>
								<CodeEditor
									original={sides.data.before}
									content={sides.data.after}
									path={entry.path}
									position={positions[`version:${entry.path}`]}
									onPosition={(position) => positionChange(`version:${entry.path}`, position)}
								/>
							</Suspense>
						)}
					</div>
				</>
			) : (
				<div className="px-8 py-20 text-center text-muted-foreground">
					<h2 className="mb-2 text-base font-medium">
						{diff.error
							? "读不到这次比较"
							: diff.isLoading
								? "正在读取…"
								: selected
									? "当前文件在这个版本没有变更"
									: "没有待比较的变更"}
					</h2>
					<p className="text-xs text-faint">
						{diff.error
							? diff.error.message
							: selected ||
								(candidate ? "作品目录与当前版本一致，没有未提交的修改。" : "这个版本与父版本内容相同。")}
					</p>
				</div>
			)}
			<div className="shrink-0 border-t border-hair-2 px-7 py-2.5 text-[11.5px] leading-[1.7] text-muted-foreground">
				差分是事实；提交摘要是解释。
				{entry && (
					<Button
						variant="link"
						size="xs"
						className="ml-2 h-auto p-0"
						data-page={entry.path}
						onClick={() => open(entry.path)}
					>
						打开 {entry.path.split("/").at(-1)} →
					</Button>
				)}
			</div>
		</div>
	);
}
