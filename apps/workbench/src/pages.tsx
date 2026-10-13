import type { LocalCommandOutput } from "@suiming/sdk";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { anchorParagraphs } from "./anchors.js";
import { type PropertyRow, propertyRows } from "./artifact-properties.js";
import { CharacterTrack } from "./axis/CharacterTrack.js";
import { axisModel, contractLane as buildContractLane } from "./axis/layout.js";
import { ContractStatus, ContractTrack } from "./axis/MiniTrack.js";
import { NeighborhoodView } from "./axis/NeighborhoodView.js";
import { PlaceUsage, ResourceFlow } from "./axis/ObjectDetails.js";
import { invoke } from "./bridge.js";
import type { ComparisonConfig } from "./code-editor.js";
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
import {
	ActionButton,
	EmptyNote,
	reviewCurrencyLabel,
	reviewLayerLabel,
	Segmented,
	Tag,
	ToolButton,
	toneText,
} from "./ui-bits.js";
import type { OpenPage, PageState } from "./view-state.js";

const CodeEditor = lazy(() => import("./code-editor.js"));

function Props({ rows, open, plain = false }: { rows: PropertyRow[]; open(page: string): void; plain?: boolean }) {
	if (!rows.length) return null;
	const values = (
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
	);
	return plain ? (
		<section className="properties mb-4" data-properties>
			{values}
		</section>
	) : (
		<details className="properties mb-6" data-properties open>
			<summary className="navigation-link -ml-1.5 mb-1 flex w-fit items-center gap-1.5 text-[13px] font-medium text-sub [&::-webkit-details-marker]:hidden">
				<ChevronDown className="size-3.5" aria-hidden="true" />
				属性
			</summary>
			{values}
		</details>
	);
}

/** 设计 / 人物 / 世界 / Intent / Contract 的正文：Markdown 渲染，frontmatter 已由属性表展示。 */
function Body({ content, title }: { content: string; title: string }) {
	let body = stripFrontmatter(content).trim();
	// 首行与页面标题完全相同才省略；其他标题与源文档都保留。
	const firstHeading = /^# +([^\n]+)(?:\n|$)/u.exec(body);
	if (firstHeading?.[1]?.trim() === title) body = body.slice(firstHeading[0].length).trim();
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
	const compactObject = file.kind === "place" || file.kind === "resource";
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
	// 局部事件视图与全局故事轴共用同一份投影。
	const axis = useMemo(() => axisModel(book, reviews), [book, reviews]);
	const contractLane =
		file.kind === "story-contract" && file.namespace === "target" ? buildContractLane(book, file) : undefined;
	const characterLane =
		file.kind === "character" ? axis.characters.find((lane) => lane.path === file.path) : undefined;
	const resourceLane = file.kind === "resource" ? axis.resources.find((lane) => lane.path === file.path) : undefined;
	const rows = propertyRows(book, file);
	const identityRows = rows.filter((row) => row.key === JSON.stringify(["aliases"]));
	const relatedPaths = new Set(
		book.links.flatMap((link) => (link.from === file.path ? [link.to] : link.to === file.path ? [link.from] : [])),
	);
	const experiencePaths = new Set(
		characterLane
			? [...characterLane.present, ...characterLane.events.map((event) => event.ordinal)].map(
					(ordinal) => axis.beats[ordinal]?.path,
				)
			: [],
	);
	const extraCharacterPaths = [...relatedPaths].filter((path) => !experiencePaths.has(path));
	const hasRelations = relatedPaths.size > 0;
	const [placeSelection, setPlaceSelection] = useState<{ path: string; volume: string }>();
	const placeVolume = placeSelection?.path === file.path ? placeSelection.volume : "";
	const [expandedKinds, setExpandedKinds] = useState<Set<string>>(new Set());
	const status: { text: string; color: string }[] = [
		{
			text:
				file.kind === "character" || contractLane || compactObject
					? ""
					: `${codePoints(stripFrontmatter(showText ? textContent : content)).toLocaleString()} 字`,
			color: "text-muted-foreground",
		},
		(showText || !hasText) && lineage
			? {
					text: lineage,
					color: hasText ? toneText(bound?.tone) : "text-muted-foreground",
				}
			: undefined,
		displayFile?.dirty ? { text: "未提交", color: "text-amber" } : undefined,
	].filter((item): item is { text: string; color: string } => !!item?.text);
	const characterRelations = file.kind === "character" && extraCharacterPaths.length > 0 && (
		<section className="mt-6 border-t border-hair pt-4" data-character-relations>
			<h2 className="mb-2 text-sm font-semibold">其他关联文档</h2>
			<ul className="space-y-1">
				{extraCharacterPaths.map((path) => (
					<li key={path}>
						<button type="button" className="navigation-link text-sm" data-page={path} onClick={() => open(path)}>
							{book.title(book.byPath.get(path)) || path}
						</button>
					</li>
				))}
			</ul>
		</section>
	);
	const showKind = file.kind !== "character" && !contractLane && !compactObject;
	const hasMetadata = showKind || status.length > 0 || identityRows.length > 0;
	return (
		<article
			className={cn("document-page", characterLane && "pb-0", contractLane && "[--content-width:1260px]")}
			data-measure={showText ? "reading" : "document"}
		>
			<div
				className={cn(contractLane && "flex flex-wrap items-center gap-x-3 gap-y-1", hasMetadata ? "mb-1" : "mb-3")}
			>
				<h1 className="text-[26px] leading-[1.4] font-semibold tracking-[.5px]">
					{isText ? book.beatTitle(file.localId) : book.title(file)}
				</h1>
				{contractLane && <ContractStatus model={axis} lane={contractLane} />}
			</div>
			{hasMetadata && (
				<div className="mb-[22px] flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
					{!showText && showKind && <span>{KIND_LABEL[file.kind] ?? file.kind}</span>}
					{status.map((item, index) => (
						<span key={item.text} className="contents">
							{((!showText && showKind) || index > 0) && <span className="text-faint">·</span>}
							<span className={item.color}>{item.text}</span>
						</span>
					))}
					{file.kind === "character" && identityRows.length > 0 && (
						<>
							{status.length > 0 && <span className="text-faint">·</span>}
							<span>
								别名：{identityRows.flatMap((row) => row.values.map((value) => value.text)).join("、")}
							</span>
						</>
					)}
				</div>
			)}

			{!showText && file.kind !== "character" && (
				<Props key={file.path} plain={isBeat || !!contractLane || compactObject} rows={rows} open={open} />
			)}
			{!showText && <Body content={content} title={book.title(file)} />}
			{contractLane && (
				<ContractTrack model={axis} lane={contractLane} projectId={book.data.projectId} open={open} />
			)}
			{file.kind === "place" && (
				<PlaceUsage
					book={book}
					model={axis}
					path={file.path}
					selectedVolume={placeVolume}
					onVolume={(volume) => setPlaceSelection({ path: file.path, volume })}
				/>
			)}
			{file.kind === "resource" && <ResourceFlow model={axis} lane={resourceLane} open={open} />}
			{file.kind === "character" && (
				<Props plain rows={rows.filter((row) => !identityRows.includes(row))} open={open} />
			)}
			{characterLane && (
				<CharacterTrack model={axis} lane={characterLane} open={open}>
					{characterRelations}
				</CharacterTrack>
			)}
			{file.kind === "character" && !characterLane && (
				<p className="mt-6 text-sm text-muted-foreground">尚无相关情节或状态变化记录。</p>
			)}
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
			{/* 邻域图辅助理解设计结构，不接在小说正文后；期待页已按阶段展示所有锚点。 */}
			{!showText &&
				!contractLane &&
				hasRelations &&
				(file.kind === "character" ? (
					!characterLane && characterRelations
				) : (
					<section className="mt-9 border-t border-hair pt-3.5" data-relations>
						<h2 className="mb-1 text-[11.5px] text-muted-foreground">关系</h2>
						<NeighborhoodView
							book={book}
							path={file.path}
							volumeId={file.kind === "place" ? placeVolume : ""}
							open={open}
							expandedKinds={expandedKinds}
							onExpand={(kind) => setExpandedKinds(new Set([...expandedKinds, kind]))}
						/>
					</section>
				))}
		</article>
	);
}
function NoText({ delegateWrite, openEditor }: { delegateWrite(): void; openEditor(): void }) {
	return (
		<EmptyNote>
			正文尚未开始。可以先完善设计，也可以从这里开始写作。
			<div className="mt-2.5 flex gap-1.5">
				<Button size="sm" onClick={delegateWrite}>
					请 Agent 写正文
				</Button>
				<Button size="sm" variant="outline" onClick={openEditor}>
					自己开始写
				</Button>
			</div>
		</EmptyNote>
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
	pane,
	onPane,
}: {
	pane: PageState["reviewPane"];
	onPane(value: PageState["reviewPane"]): void;
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
	const active = report.findings.length ? Math.max(0, Math.min(selection.active, report.findings.length - 1)) : -1;
	const finding = report.findings[active];
	const root = useRef<HTMLDivElement>(null);
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
		if (active < 0 || marks.size === 0 || pane !== "current") return;
		root.current?.querySelector(".issue-current p[data-mark='true']")?.scrollIntoView({ block: "center" });
	}, [active, marks, pane]);
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
	const choose = (index: number) => {
		root.current?.querySelector("[data-scroll-key='review-selected']")?.scrollTo({ top: 0 });
		onSelection({ ...selection, active: index, anchor: report.findings[index]?.paths[0] ?? anchor });
	};
	const indexes = anchored[active] ?? [];
	return (
		<div ref={root} className="@container/review flex min-h-0 flex-1 flex-col">
			<header className="shrink-0 border-b border-hair-2 px-4 py-2">
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<Tag tone={verdictTone(report.verdict)}>{verdictLabel(report.verdict)}</Tag>
					<span className={report.current ? "text-primary" : "text-amber"}>
						{reviewCurrencyLabel(report.current)}
					</span>
					<span className="text-muted-foreground">
						{reviewLayerLabel(report.layer)} · 审的是 {book.revisionLabel(report.revision)}
					</span>
					<Button
						size="xs"
						variant="outline"
						className="ml-auto"
						onClick={() =>
							sendToAgent(`请复核审稿 ${report.id}（${verdictLabel(report.verdict)}）：${report.summary}`)
						}
					>
						复核整份审稿
					</Button>
				</div>
				<details data-review-summary className="mt-2 text-xs">
					<summary className="cursor-pointer text-muted-foreground">
						<h1 className="inline font-medium">审稿报告 · {report.findings.length} 条问题</h1> · 结论与范围
					</summary>
					<div className="mt-2 max-h-48 overflow-auto" data-scroll-key="review-summary">
						<p className="mb-2 whitespace-pre-wrap leading-relaxed">{report.summary}</p>
						<p className="text-muted-foreground">范围：{subject || "未指定文件"}</p>
						{report.paths.map((path) => (
							<Button key={path} variant="link" size="xs" data-page={path} onClick={() => open(path)}>
								{path}
							</Button>
						))}
					</div>
				</details>
			</header>
			<div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] @min-[640px]/review:grid-cols-[200px_minmax(0,1fr)] @min-[640px]/review:grid-rows-1">
				<section
					aria-label="审稿结论与问题"
					className="min-h-0 border-b border-hair-2 @min-[640px]/review:overflow-auto @min-[640px]/review:border-r @min-[640px]/review:border-b-0"
					data-scroll-key="review-findings"
				>
					<div className="p-2 @min-[640px]/review:hidden">
						<Select value={String(active)} onValueChange={(value) => value !== null && choose(Number(value))}>
							<SelectTrigger aria-label="选择审稿意见" className="h-auto min-h-8 w-full">
								<span className="min-w-0 whitespace-normal text-left">
									{finding ? `${active + 1} / ${report.findings.length} · ${finding.title}` : "没有审稿意见"}
								</span>
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{report.findings.map((item, index) => (
										<SelectItem key={`${item.title}:${item.paths.join(";")}`} value={String(index)}>
											{index + 1}. {item.title}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
					<div className="hidden p-2 @min-[640px]/review:block">
						<p className="px-2 py-1 text-xs text-muted-foreground">审稿意见 · {report.findings.length}</p>
						{report.findings.map((item, index) => (
							<Button
								key={`${item.title}:${item.paths.join(";")}`}
								variant="ghost"
								className="mb-1 h-auto w-full justify-start whitespace-normal px-2 py-2 text-left text-xs aria-pressed:bg-muted"
								aria-pressed={active === index}
								onClick={() => choose(index)}
							>
								{index + 1}. {item.title}
							</Button>
						))}
					</div>
				</section>
				<div className="flex min-h-0 min-w-0 flex-col">
					<section
						aria-label="当前审稿意见"
						className="max-h-[40%] shrink-0 overflow-auto border-b border-hair-2 px-4 py-3"
						data-scroll-key="review-selected"
					>
						{finding ? (
							<>
								<h2 className="mb-1 text-sm font-semibold">
									{finding.title} {indexes.length > 0 && <Tag tone="amber">{paragraphLabel(indexes)}</Tag>}
								</h2>
								<p className="text-[12.5px] leading-[1.7] whitespace-pre-wrap">{finding.evidence.trim()}</p>
								{finding.suggestion.trim() && (
									<p className="mt-1 text-[12.5px] leading-[1.7] whitespace-pre-wrap text-ink-3">
										建议 · {finding.suggestion.trim()}
									</p>
								)}
							</>
						) : (
							<p className="text-xs text-muted-foreground">没有意见：审稿人判断被审内容成立。</p>
						)}
					</section>
					{finding && (
						<div className="flex shrink-0 flex-wrap gap-1.5 border-b border-hair-2 px-4 py-2">
							{finding.paths.map((path) => (
								<Button
									key={path}
									size="xs"
									variant="outline"
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
								size="xs"
								variant="outline"
								onClick={() =>
									sendToAgent(
										`请复核这条审稿意见的修复是否充分：${finding.title}${indexes.length > 0 ? `（${anchor} ${paragraphLabel(indexes)}）` : ""}\n${finding.evidence}${finding.suggestion ? `\n建议：${finding.suggestion}` : ""}`,
									)
								}
							>
								复核这条意见
							</Button>
						</div>
					)}
					<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hair-2 px-4 py-2">
						<div className="@min-[960px]/review:hidden">
							<Segmented
								value={pane}
								options={[
									{ id: "current", label: "当前稿" },
									{ id: "reviewed", label: "被审的稿" },
								]}
								onChange={onPane}
							/>
						</div>
						<span className="min-w-0 break-all text-xs text-muted-foreground">
							{anchor || "没有指向具体文件"}
						</span>
					</div>
					<div className="grid min-h-0 flex-1 @min-[960px]/review:grid-cols-2">
						<div
							data-scroll-key="review-evidence"
							className={`${pane === "reviewed" ? "" : "hidden"} min-w-0 overflow-auto px-4 py-3 @min-[960px]/review:block @min-[960px]/review:border-r`}
						>
							<p className="mb-2 text-xs text-muted-foreground">
								被审的稿 · {book.revisionLabel(report.revision)}
							</p>
							{reviewed.data ? (
								<pre className="evidence-text">{stripFrontmatter(reviewed.data.content)}</pre>
							) : (
								<p className="text-xs text-muted-foreground">
									{reviewed.error
										? reviewed.error.message
										: anchor
											? "正在读取被审的稿…"
											: "这份审稿没有指向具体文件"}
								</p>
							)}
						</div>
						<div
							data-scroll-key="review-current"
							className={`issue-current ${pane === "current" ? "" : "hidden"} min-w-0 overflow-auto px-4 py-3 @min-[960px]/review:block`}
						>
							<p
								className={`${report.current ? "hidden @min-[960px]/review:block" : ""} mb-2 text-xs text-muted-foreground`}
							>
								<span className="hidden @min-[960px]/review:inline">当前稿</span>{" "}
								{!report.current && <span className="text-amber">段号可能已错位</span>}
							</p>
							{current.data ? (
								body ? (
									<Prose content={body} selected={-1} compact marks={marks} />
								) : (
									<p className="text-xs text-muted-foreground">（当前没有内容）</p>
								)
							) : (
								<p className="text-xs text-muted-foreground">
									{current.error ? current.error.message : anchor ? "正在读取…" : "这份报告没有指向具体文件"}
								</p>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** 版本页：某个 ProjectRevision 相对父版本的差分，或候选相对当前版本。 */
export function VersionPage({
	comparison,
	book,
	revisionId,
	open,
	selected,
	onSelect: setSelected,
	positions,
	positionChange,
}: {
	comparison: Omit<ComparisonConfig, "before" | "after">;
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
	const [filesOpen, setFilesOpen] = useState(false);
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
	const entryIndex = diff.data?.findIndex((item) => item.path === entry?.path) ?? -1;
	const previousFile = entryIndex > 0 ? diff.data?.[entryIndex - 1] : undefined;
	const nextFile = entryIndex >= 0 ? diff.data?.[entryIndex + 1] : undefined;
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
	const onStatus = comparison.onStatus;
	useEffect(() => {
		if (!entry || sides.error || sides.data?.path !== entry.path) onStatus(null);
	}, [entry, sides.error, sides.data, onStatus]);
	const label = candidate ? CANDIDATE_TITLE : book.revisionLabel(revisionId);
	const previous = candidate ? book.headLabel : revision?.parentId ? book.revisionLabel(revision.parentId) : "空作品";
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="shrink-0 border-b border-hair-2 px-4 py-2" data-version-context>
				<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button size="xs" variant="outline" aria-label="选择作品版本">
									{label}
									<ChevronDown data-icon="inline-end" />
								</Button>
							}
						/>
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
					<Popover open={filesOpen} onOpenChange={setFilesOpen}>
						<PopoverTrigger
							render={
								<Button
									size="xs"
									variant="ghost"
									aria-label="选择变更文件"
									disabled={!diff.data?.length}
									className="h-auto min-h-7 min-w-0 flex-1 justify-between text-left"
								>
									<span className="min-w-0 break-all whitespace-normal">
										{entry?.path ?? (selected || "选择文件")}
									</span>
									<span className="shrink-0 text-muted-foreground">
										{diff.data
											? entry
												? `${entryIndex + 1} / ${diff.data.length} 文件`
												: `${diff.data.length} 个文件`
											: ""}
									</span>
									<ChevronDown className="shrink-0" />
								</Button>
							}
						/>
						<PopoverContent align="start" className="w-[480px] max-w-[calc(100vw-32px)] p-0">
							<Command>
								<CommandInput aria-label="搜索变更文件" placeholder="搜索路径…" />
								<CommandList>
									<CommandEmpty>没有匹配的变更文件</CommandEmpty>
									{diff.data?.map((item) => (
										<CommandItem
											key={item.path}
											value={item.path}
											onSelect={() => {
												setSelected(item.path);
												setFilesOpen(false);
											}}
										>
											<span className="shrink-0 text-muted-foreground">
												{item.kind === "added" ? "新增" : item.kind === "deleted" ? "删除" : "修改"}
											</span>
											<span className="min-w-0 break-all">{item.path}</span>
											{entry?.path === item.path && <span className="ml-auto shrink-0">当前</span>}
										</CommandItem>
									))}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
					{(diff.data?.length ?? 0) > 1 && entry && (
						<fieldset className="flex shrink-0 items-center" aria-label="变更文件导航">
							<ToolButton
								label="上一个变更文件"
								description={previousFile?.path ?? ""}
								disabled={!previousFile}
								disabledReason="已经是第一个变更文件"
								onClick={() => previousFile && setSelected(previousFile.path)}
							>
								<ChevronLeft />
							</ToolButton>
							<ToolButton
								label="下一个变更文件"
								description={nextFile?.path ?? ""}
								disabled={!nextFile}
								disabledReason="已经是最后一个变更文件"
								onClick={() => nextFile && setSelected(nextFile.path)}
							>
								<ChevronRight />
							</ToolButton>
						</fieldset>
					)}
					<Popover>
						<PopoverTrigger
							render={
								<Button size="xs" variant="ghost">
									详情
								</Button>
							}
						/>
						<PopoverContent align="end" className="text-xs">
							<p className="break-all">
								{candidate ? `作品目录 · 基线 ${previous}` : `${label} · ${revisionId}`}
							</p>
							{!candidate && (
								<p className="break-all">
									父版本：{previous} · {revision?.parentId ?? "无"}
								</p>
							)}
							{entry && (
								<Button size="xs" variant="outline" onClick={() => open(entry.path)}>
									打开当前作品中的文件
								</Button>
							)}
						</PopoverContent>
					</Popover>
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
							<span className="text-amber">将整个作品恢复到 {label} 的内容并提交为新版本，历史保留。</span>
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
			</div>
			{entry ? (
				<div className="min-h-0 flex-1">
					{sides.error ? (
						<div className="space-y-3 p-5">
							<p role="alert" className="text-xs text-destructive">
								{sides.error.message}
							</p>
							<Button
								variant="outline"
								size="sm"
								disabled={sides.isFetching}
								onClick={() => void sides.refetch()}
							>
								重新读取正文
							</Button>
						</div>
					) : sides.data?.path !== entry.path ? (
						<p className="p-5 text-[11.5px] text-muted-foreground">正在计算差异…</p>
					) : (
						<Suspense fallback={<p className="p-5 text-[11.5px] text-muted-foreground">正在计算差异…</p>}>
							<CodeEditor
								comparison={{ ...comparison, before: `之前 · ${previous}`, after: `之后 · ${label}` }}
								autoFocus={false}
								original={sides.data.before}
								content={sides.data.after}
								path={entry.path}
								position={positions[`version:${entry.path}`]}
								onPosition={(position) => positionChange(`version:${entry.path}`, position)}
							/>
						</Suspense>
					)}
				</div>
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
					<p role={diff.error ? "alert" : undefined} className="text-xs text-faint">
						{diff.error
							? diff.error.message
							: diff.isLoading
								? "正在读取变更清单，请稍候。"
								: selected ||
									(candidate ? "作品目录与当前版本一致，没有未提交的修改。" : "这个版本与父版本内容相同。")}
					</p>
					{!diff.error && !diff.isLoading && !!diff.data?.length && (
						<Button
							className="mt-4"
							variant="outline"
							size="sm"
							onClick={() => {
								const first = diff.data?.[0];
								if (first) setSelected(first.path);
							}}
						>
							查看本版本的变更
						</Button>
					)}
					{diff.error && (
						<Button
							className="mt-3"
							variant="outline"
							size="sm"
							disabled={diff.isFetching}
							onClick={() => void diff.refetch()}
						>
							重新读取版本
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
