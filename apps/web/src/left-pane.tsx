import { ArrowDownWideNarrow, ChevronRight, ChevronsUpDown, Hash, LocateFixed, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
	type Book,
	CANDIDATE_TITLE,
	CANDIDATE_VERSION,
	issuePage,
	KIND_LABEL,
	pageKind,
	pageTarget,
	type ReviewReport,
	reviewsFor,
	shortId,
	versionPage,
} from "./model.js";
import { verdictLabel } from "./review-verdict.js";
import { Hint, PanelToolbar, reviewCurrencyLabel, reviewLayerLabel, ToolButton } from "./ui-bits.js";
import type { ViewState } from "./view-state.js";

export interface PaneProps {
	book: Book;
	reviews: ReviewReport[];
	view: ViewState;
	page: string;
	patch(partial: Partial<ViewState>): void;
	open(page: string, extra?: Partial<ViewState>): void;
}

const CONTRACT_MARK = "#b45309";
const REVIEW_MARK = "#7c3aed";
const Tools = ({ children }: { children: React.ReactNode }) => (
	<PanelToolbar className="justify-center">{children}</PanelToolbar>
);
const List = ({ children }: { children: React.ReactNode }) => (
	<div data-side-scroll="list" className="min-h-0 flex-1 overflow-auto px-2 pb-2">
		{children}
	</div>
);

/** 大纲：卷 → Beat，每行显示正文有无、承诺锚点与 Review evidence。 */
export function SpinePane({ book, reviews, view, page, patch, open }: PaneProps) {
	const volumes = book.data.volumes.length
		? book.data.volumes
		: [{ id: "all", title: "全部情节", beatIds: book.order }];
	const allOpen = volumes.every((volume) => view.openVols[volume.id] !== false);
	const index = book.data.files.find((file) => file.kind === "story-index" && file.namespace === "target");
	const current = book.byPath.get(pageKind(page) === "file" ? pageTarget(page) : page);
	// 与文件栏的「定位当前文件」一致：没有可定位的情节时禁用并说明，不点了没反应。
	const currentVolume = book.volumeOf(current?.localId ?? view.axisSelected);
	return (
		<>
			<Tools>
				<ToolButton
					label="定位当前情节"
					disabled={!currentVolume}
					disabledReason="当前页面不是某个情节，故事轴上也没有选中的情节"
					onClick={() => {
						const volume = currentVolume;
						if (volume) patch({ openVols: { ...view.openVols, [volume.id]: true } });
						requestAnimationFrame(() =>
							document
								.querySelector<HTMLElement>('[data-on="true"].beat-row')
								?.scrollIntoView({ block: "center" }),
						);
					}}
				>
					<LocateFixed />
				</ToolButton>
				<ToolButton
					label={allOpen ? "折叠全部卷" : "展开全部卷"}
					onClick={() => patch({ openVols: Object.fromEntries(volumes.map((volume) => [volume.id, !allOpen])) })}
				>
					<ChevronsUpDown />
				</ToolButton>
				<ToolButton
					label={view.showIds ? "隐藏标识符" : "显示标识符"}
					on={view.showIds}
					onClick={() => patch({ showIds: !view.showIds })}
				>
					<Hash />
				</ToolButton>
			</Tools>
			<List>
				{volumes.map((volume) => {
					const isOpen = view.openVols[volume.id] !== false;
					const withText = volume.beatIds.filter((id) => book.text(id)).length;
					return (
						<div key={volume.id}>
							<Hint side="right" content={`${volume.title} · ${withText} / ${volume.beatIds.length} 有正文`}>
								<button
									type="button"
									className="tree-row"
									aria-expanded={isOpen}
									onClick={() => patch({ openVols: { ...view.openVols, [volume.id]: !isOpen } })}
								>
									<ChevronRight
										size={11}
										className={`shrink-0 text-muted-foreground ${isOpen ? "rotate-90" : ""}`}
									/>
									<span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">{volume.title}</span>
									<span className="text-[10.5px] text-faint tabular-nums">
										{withText} / {volume.beatIds.length}
									</span>
								</button>
							</Hint>
							{isOpen &&
								volume.beatIds.map((id) => {
									const beat = book.beat(id);
									const text = book.text(id);
									const marks = [
										...book.links
											// advance 几乎每个 Beat 都有，标出来等于没标；左栏只标 open / resolve，完整锚点看故事轴。
											.filter(
												(link) =>
													link.from === beat?.path &&
													(link.key === "contracts.open" || link.key === "contracts.resolve"),
											)
											.map((link) => ({
												key: `${link.key}:${link.to}`,
												title: `${book.title(book.byPath.get(link.to))} · ${link.key === "contracts.open" ? "建立期待" : "回应期待"}`,
												color: CONTRACT_MARK,
												shape: "square" as const,
											})),
										// 只标锚到这一个 Beat 的报告；覆盖全书的设计审稿在故事轴上以区间表示，不在每行重复。
										...(beat
											? reviewsFor(book, reviews, beat.path)
													.filter(
														(report) =>
															new Set(report.paths.map((path) => book.byPath.get(path)?.localId))
																.size === 1,
													)
													.map((report) => ({
														key: `review:${report.id}`,
														title: `审稿${verdictLabel(report.verdict)} · ${report.current ? "对应当前版本" : "关联内容已有更新"}`,
														color: REVIEW_MARK,
														shape: "tri" as const,
													}))
											: []),
									];
									const selected =
										pageKind(page) === "artifact" && (page === beat?.path || page === text?.path);
									const current = view.axisSelected === id;
									return (
										<Hint
											side="right"
											content={[
												`${book.beatTitle(id)} · ${id}`,
												!beat
													? "故事目录里有这个情节，但找不到它的设计文件"
													: text
														? text.dirty
															? "正文有未提交修改"
															: book.currencyOf(id)?.state === "design-changed"
																? "已有正文，设计已有更新"
																: "已提交正文"
														: "仅设计",
												...marks.map((mark) => mark.title),
											].join("\n")}
											key={id}
										>
											<button
												type="button"
												className="beat-row"
												data-on={selected}
												data-cur={current}
												aria-current={current ? "location" : undefined}
												data-page={beat?.path}
												onClick={() => beat && open(beat.path)}
												aria-disabled={!beat || undefined}
											>
												<span className={`h-4 w-0.5 rounded-[1px] ${current ? "bg-primary" : ""}`} />
												<span
													className={`size-[7px] rounded-full border-[1.5px] ${
														text
															? text.dirty
																? "border-amber bg-white"
																: book.currencyOf(id)?.state === "design-changed"
																	? "border-amber bg-[linear-gradient(90deg,var(--amber)_50%,var(--background)_50%)]"
																	: "border-success bg-success"
															: "border-faint"
													}`}
												/>
												<span className={`truncate text-[12.5px] ${beat ? "" : "text-faint"}`}>
													{view.showIds ? id : book.beatTitle(id)}
												</span>
												<span className="flex items-center gap-[3px]">
													{marks.map((mark) =>
														mark.shape === "tri" ? (
															<span
																key={mark.key}
																aria-hidden
																className="tri"
																style={{ borderBottomColor: mark.color }}
															/>
														) : (
															<span
																key={mark.key}
																aria-hidden
																className="block size-[7px] rounded-[2px]"
																style={{ background: mark.color }}
															/>
														),
													)}
												</span>
											</button>
										</Hint>
									);
								})}
						</div>
					);
				})}
				{volumes.every((volume) => volume.beatIds.length === 0) && (
					<p className="side-note">还没有情节。可以请 Agent 先做设计。</p>
				)}
				{book.data.derivedError && (
					<p className="side-note text-amber">正文时效无法从版本历史派生：{book.data.derivedError}</p>
				)}
				{book.data.storyIndexError && (
					<p className="side-note text-amber">
						index.yaml 无法解析，以上按文件顺序列出；Checker 会在检查时报错：{book.data.storyIndexError}
					</p>
				)}
				{index && (
					<button
						type="button"
						className="tree-row mt-2 text-muted-foreground"
						data-on={page === index.path}
						data-page={index.path}
						onClick={() => open(index.path)}
					>
						<span className="min-w-0 flex-1 truncate text-[12px]">目录 · index.yaml</span>
					</button>
				)}
			</List>
		</>
	);
}

const ID_GROUPS: [string, string][] = ["character", "story-contract", "place", "resource", "world"].map((kind) => [
	kind,
	KIND_LABEL[kind] ?? kind,
]);
/** 身份：人物、承诺、地点、资源、世界；计数是全书范围内引用它的 Beat 数。 */
export function IdsPane({ book, view, page, patch, open }: PaneProps) {
	const byCount = view.idsByCount;
	const setByCount = (idsByCount: boolean) => patch({ idsByCount });
	const allOpen = ID_GROUPS.every(([kind]) => view.openGroups[kind]);
	return (
		<>
			<Tools>
				<ToolButton
					label={byCount ? "恢复默认排序" : "按引用数排序"}
					on={byCount}
					onClick={() => setByCount(!byCount)}
				>
					<ArrowDownWideNarrow />
				</ToolButton>
				<ToolButton
					label={allOpen ? "折叠全部分类" : "展开全部分类"}
					onClick={() => patch({ openGroups: Object.fromEntries(ID_GROUPS.map(([kind]) => [kind, !allOpen])) })}
				>
					<ChevronsUpDown />
				</ToolButton>
				{view.axisRange && (
					<span className="ml-1.5 truncate text-[11px] text-amber-ink">
						区间 {view.axisRange.start.replace("beat-", "")} → {view.axisRange.end.replace("beat-", "")}
					</span>
				)}
			</Tools>
			<List>
				{ID_GROUPS.map(([kind, label]) => {
					const isOpen = !!view.openGroups[kind];
					const files = book.data.files.filter((file) => file.kind === kind && file.namespace === "target");
					const items = files.map((file) => {
						if (kind === "story-contract") {
							const state = book.contractState(file.localId, book.order.length - 1);
							return {
								file,
								meta: state.label,
								color:
									state.opened && !state.resolved
										? CONTRACT_MARK
										: state.resolved
											? "var(--success)"
											: "#a1a1aa",
								count: state.opened ? 1 : 0,
							};
						}
						// 故事轴刷选了区间就数区间内的引用，否则数全书范围内的。
						const count = view.axisRange
							? book.refCountInRange(
									file.path,
									book.ordinal(view.axisRange.start),
									book.ordinal(view.axisRange.end),
								)
							: book.refCountInRange(file.path, 0, book.order.length - 1);
						return {
							file,
							meta: count ? `${count} 个情节` : "—",
							color: count ? "var(--success)" : "#d4d4d8",
							count,
						};
					});
					if (byCount) items.sort((a, b) => b.count - a.count);
					return (
						<div key={kind}>
							<button
								type="button"
								className="tree-row"
								aria-expanded={isOpen}
								onClick={() => patch({ openGroups: { ...view.openGroups, [kind]: !isOpen } })}
							>
								<ChevronRight
									size={11}
									className={`shrink-0 text-muted-foreground ${isOpen ? "rotate-90" : ""}`}
								/>
								<span className="flex-1 text-[12.5px] font-semibold">{label}</span>
								<span className="text-[10.5px] text-faint">{files.length}</span>
							</button>
							{isOpen &&
								items.map(({ file, meta, color, count }) => (
									<button
										type="button"
										key={file.path}
										className="tree-row gap-2 pl-[21px]"
										data-on={page === file.path}
										data-page={file.path}
										onClick={() => open(file.path)}
									>
										<span className={`min-w-0 flex-1 truncate text-[12.5px] ${count ? "font-medium" : ""}`}>
											{book.title(file)}
										</span>
										<span className="text-[10.5px] whitespace-nowrap tabular-nums" style={{ color }}>
											{meta}
										</span>
									</button>
								))}
						</div>
					);
				})}
				<p className="side-note">计数是{view.axisRange ? "故事轴选中区间里" : "全书"}引用它的情节数。</p>
			</List>
		</>
	);
}

/** 材料：创作意图、原作、参考资料、审稿与版本。 */
export function SourcesPane({ book, reviews, page, open }: PaneProps) {
	const target = book.data.files.filter((file) => file.namespace === "target");
	const intents = target.filter((file) => file.kind === "intent");
	const sources = [...new Set(book.data.files.filter((file) => file.namespace !== "target").map((f) => f.namespace))];
	const references = target.filter((file) => file.kind.startsWith("reference-") || file.kind === "style-evidence");
	const currentVersion = pageKind(page) === "version" ? pageTarget(page) : "";
	const issue = pageKind(page) === "issue" ? pageTarget(page) : "";
	const item = (key: string, on: boolean, title: string, meta: string, onClick: () => void) => (
		<button type="button" key={key} data-page={key} className="item-btn" data-on={on} onClick={onClick}>
			<span className={`truncate text-[12.5px] ${on ? "font-semibold" : ""}`}>{title}</span>
			<span className="text-[11px] text-muted-foreground">{meta}</span>
		</button>
	);
	const Head = ({ label, note }: { label: string; note: string }) => (
		<div className="group-head">
			<span>{label}</span>
			<span className="text-faint">{note}</span>
		</div>
	);
	return (
		<>
			{/* 空工具行只为与其它侧栏对齐；创作意图就列在下面第一组，原来这里另有一个只开第一份意图的按钮。 */}
			<Tools>{null}</Tools>
			<List>
				<Head label="创作意图" note={intents.length ? "" : "尚无"} />
				{intents.map((file) =>
					item(file.path, page === file.path, book.title(file), `${file.codePoints.toLocaleString()} 字`, () =>
						open(file.path),
					),
				)}
				<Head label="原作" note={sources.length ? `${sources.length} 份` : "无"} />
				{sources.map((sourceId) => {
					const files = book.data.files.filter((file) => file.namespace === sourceId);
					const first = files.find((file) => file.kind === "story-index") ?? files[0];
					return item(
						first?.path ?? sourceId,
						files.some((file) => file.path === page),
						sourceId,
						`${files.length} 个抽取文件`,
						() => first && open(first.path),
					);
				})}
				{sources.length === 0 && <p className="side-note">没有导入原作。</p>}
				<Head label="参考资料" note="" />
				{references.map((file) =>
					item(file.path, page === file.path, book.title(file), KIND_LABEL[file.kind] ?? file.kind, () =>
						open(file.path),
					),
				)}
				<Head label="审稿" note="" />
				{reviews.map((report) =>
					item(
						issuePage(report.id),
						issue === report.id,
						`审稿 ${shortId(report.id)}`,
						`${reviewLayerLabel(report.layer)} · ${verdictLabel(report.verdict)} · ${reviewCurrencyLabel(report.current)} · ${report.findings.length} 条意见`,
						() => open(issuePage(report.id)),
					),
				)}
				{reviews.length === 0 && <p className="side-note">还没有审稿。</p>}
				<Head label="版本" note={`当前 ${book.headLabel}`} />
				{book.data.dirty &&
					item(
						CANDIDATE_VERSION,
						currentVersion === "candidate",
						CANDIDATE_TITLE,
						`${book.data.files.filter((file) => file.dirty).length} 个文件与 ${book.headLabel} 不同`,
						() => open(CANDIDATE_VERSION),
					)}
				{[...book.data.revisions]
					.reverse()
					.map((revision) =>
						item(
							versionPage(revision.id),
							currentVersion === revision.id,
							`${book.revisionLabel(revision.id)} · ${shortId(revision.id)}`,
							revision.id === book.data.revisionId ? "当前" : "",
							() => open(versionPage(revision.id)),
						),
					)}
			</List>
		</>
	);
}

/** 搜索：按标题、id 与路径匹配全部作品文件。 */
export function SearchPane({
	book,
	page,
	open,
	query,
	setQuery,
}: PaneProps & { query: string; setQuery(value: string): void }) {
	const needle = query.trim().toLowerCase();
	const files = book.data.files.filter((file) => file.kind !== "story-index");
	const results = (
		needle
			? files.filter((file) => `${book.title(file)} ${file.localId} ${file.path}`.toLowerCase().includes(needle))
			: files.slice(0, 12)
	).slice(0, 60);
	return (
		<>
			<PanelToolbar className="gap-2 px-2.5">
				<div className="flex h-7 flex-1 items-center gap-1.5 rounded-md border bg-white px-2 text-faint">
					<Search className="size-[12px]" />
					<Input
						aria-label="搜索作品"
						placeholder="搜索标题、人物、读者期待…"
						value={query}
						autoFocus
						className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
			</PanelToolbar>
			<List>
				<div className="group-head">
					<span>
						{results.length} 个结果 · {needle ? "按标题、id 与路径" : "最近条目"}
					</span>
				</div>
				{results.map((file) => (
					<button
						type="button"
						key={file.path}
						className="item-btn"
						data-on={page === file.path}
						data-page={file.path}
						onClick={() => open(file.path, file.kind === "story-beat" ? { beatView: "design" } : undefined)}
					>
						<span className="truncate text-[12.5px]">{book.title(file)}</span>
						<span className="truncate text-[11px] text-muted-foreground">{file.path}</span>
					</button>
				))}
				{needle && results.length === 0 && <p className="side-note">没有匹配「{query}」的作品内容。</p>}
			</List>
		</>
	);
}
