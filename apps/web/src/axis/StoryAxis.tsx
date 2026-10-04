import { Minus, Plus } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Book, issuePage, type ReviewReport } from "../model.js";
import { verdictColor, verdictLabel } from "../review-verdict.js";
import { Hint, reviewCurrencyLabel } from "../ui-bits.js";
import {
	type AxisModel,
	arcHeight,
	arcOpacity,
	axisModel,
	type CharacterLane,
	type ContractLane,
	contractStatus,
	type ResourceLane,
	visibleRange,
	type WorldLane,
} from "./layout.js";

const DEFAULT_LABEL_W = 184;
const MIN_LABEL_W = 120;
const MAX_LABEL_W = 420;
const HEAD_H = 64;
const GROUP_H = 28;
const LANE_H = 26;
/** 列宽默认按可用宽度适应（全书或当前卷都是），作者可用 ⌘ 滚轮 / 按钮连续缩放。 */
const DEFAULT_COL_W = 18;
const MIN_COL_W = 4;
const MAX_COL_W = 120;
const clampColumn = (value: number) => Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.round(value)));
const LEFT = 8;

type Row = { key: string; label: string; h: number; y: number } & (
	| { kind: "group" | "coverage" | "review" | "spans" | "arcs" }
	| { kind: "group-toggle"; on: boolean; toggle: string; toggleLabel: string }
	| { kind: "contract"; lane: ContractLane }
	| { kind: "character"; lane: CharacterLane }
	| { kind: "world"; lane: WorldLane }
	| { kind: "resource"; lane: ResourceLane }
);
const ARC_H = 72;
const TOP_CHARACTERS = 8;

function rows(model: AxisModel, allCharacters: boolean, worlds: boolean, resources: boolean): Row[] {
	const list: Row[] = [];
	let y = HEAD_H;
	const push = (row: Row) => {
		list.push({ ...row, y });
		y += row.h;
	};
	push({ kind: "coverage", key: "coverage", label: "正文", h: LANE_H, y });
	// 空泳道不画：没有单 Beat 审稿就没有这一行。
	if (model.reviews.size > 0) push({ kind: "review", key: "review", label: "审稿 · 单个情节", h: LANE_H, y });
	if (model.spans.length > 0)
		push({ kind: "spans", key: "spans", label: "审稿 · 跨情节", h: LANE_H + (model.spans.length - 1) * 8, y });
	push({ kind: "group", key: "g:contracts", label: `读者期待 · ${model.contracts.length} 条`, h: GROUP_H, y });
	for (const lane of model.contracts)
		push({ kind: "contract", key: lane.path, label: lane.title, h: LANE_H, y, lane });
	if (model.arcs.length > 0)
		push({
			kind: "arcs",
			key: "arcs",
			label: `因果 · refs.beat ${model.arcs.length + model.adjacentArcs} 条`,
			h: ARC_H,
			y,
		});
	const shown = allCharacters
		? model.characters
		: [...model.characters]
				.sort((a, b) => b.present.length - a.present.length)
				.slice(0, TOP_CHARACTERS)
				.sort((a, b) => (a.present[0] ?? 0) - (b.present[0] ?? 0));
	push({
		kind: "group-toggle",
		key: "g:characters",
		label: `人物 · ${model.characters.length} 人`,
		h: GROUP_H,
		y,
		on: allCharacters,
		toggle: "characters",
		toggleLabel:
			model.characters.length > TOP_CHARACTERS
				? allCharacters
					? `前 ${TOP_CHARACTERS}`
					: `全部 ${model.characters.length}`
				: "",
	});
	for (const lane of shown) push({ kind: "character", key: lane.path, label: lane.title, h: LANE_H, y, lane });
	push({
		kind: "group-toggle",
		key: "g:worlds",
		label: `世界文档 · ${model.worlds.length} 份`,
		h: GROUP_H,
		y,
		on: worlds,
		toggle: "worlds",
		toggleLabel: model.worlds.length > 0 ? (worlds ? "收起" : "展开") : "",
	});
	if (worlds)
		for (const lane of model.worlds) push({ kind: "world", key: lane.path, label: lane.title, h: LANE_H, y, lane });
	push({
		kind: "group-toggle",
		key: "g:resources",
		label: `资源流转 · ${model.resources.length} 件`,
		h: GROUP_H,
		y,
		on: resources,
		toggle: "resources",
		toggleLabel: model.resources.length > 0 ? (resources ? "收起" : "展开") : "",
	});
	if (resources)
		for (const lane of model.resources)
			push({ kind: "resource", key: lane.path, label: lane.title, h: LANE_H, y, lane });
	return list;
}

/** SVG 图元当按钮用：鼠标点击与 Enter 等价，也让 lint 认出它是交互元素。 */
const press = (handler: () => void) => ({
	role: "button" as const,
	tabIndex: 0,
	className: "cursor-pointer outline-none focus-visible:stroke-ring",
	onClick: handler,
	onKeyDown: (event: KeyboardEvent) => {
		if (event.key === "Enter") handler();
	},
});

/**
 * 故事轴：横轴 = index.yaml 的 Beat 顺序，按卷分段；纵向是叠在同一坐标上的泳道。
 * 每个图元都是作品里的一条记录，title 说明来自哪个字段；点击回到 artifact。
 */
export function StoryAxis({
	book,
	reviews,
	selected,
	volume: entered,
	onVolume,
	onSelect,
	onObserve,
	open,
	expanded,
	onExpand,
	showFindings,
	onToggleFindings,
	range: brushed,
	onRange,
	onReference,
	column,
	onColumn,
	labelWidth,
	onLabelWidth,
	onHelp,
}: {
	book: Book;
	reviews: ReviewReport[];
	selected: string;
	/** 进入的卷；null = 全书。 */
	volume: string | null;
	onVolume(volumeId: string | null): void;
	onSelect(beatId: string): void;
	onObserve(beatId: string): void;
	open(page: string): void;
	expanded: { characters: boolean; worlds: boolean; resources: boolean };
	onExpand(group: "characters" | "worlds" | "resources", on: boolean): void;
	showFindings: boolean;
	onToggleFindings(on: boolean): void;
	/** 刷选区间（Beat id）；null 表示没有。 */
	range: { start: string; end: string } | null;
	onRange(range: { start: string; end: string } | null): void;
	/** 把区间作为作品引用交给 Agent。 */
	onReference(range: { start: string; end: string }): void;
	/** 打开帮助模态框（图例与操作）。 */
	onHelp(): void;
	/** 标题列宽度；拖右边缘调整并存进 view state。 */
	labelWidth: number;
	onLabelWidth(width: number): void;
	/** 列宽覆盖；null = 按当前全书或卷的可用宽度适应。 */
	column: number | null;
	onColumn(column: number | null): void;
}) {
	const model = useMemo(() => axisModel(book, reviews), [book, reviews]);
	const maxArcSpan = useMemo(() => Math.max(1, ...model.arcs.map((arc) => arc.to - arc.from)), [model]);
	// 分屏时可能同时有两条故事轴，裁剪区的 id 不能撞。
	const arcClip = `axis-arcs-${useId().replace(/[^\w-]/g, "")}`;
	const range = visibleRange(model, entered);
	const beats = model.beats.slice(range.start, range.end + 1);
	const [available, setAvailable] = useState(0);
	const LABEL_W = Math.min(MAX_LABEL_W, Math.max(MIN_LABEL_W, labelWidth || DEFAULT_LABEL_W));
	// 适应窗口保留小数列宽，避免逐列取整后在右侧累积出空白。
	const fitW = available > 0 ? (available - LABEL_W - LEFT - 24) / Math.max(beats.length, 1) : DEFAULT_COL_W;
	const colW = column ?? Math.min(MAX_COL_W, Math.max(MIN_COL_W, fitW));
	// 列变窄时标记按比例缩小，刻度改为每隔几列一个；卷标题始终保留。
	const dotR = Math.min(4.5, Math.max(2, colW * 0.25));
	const glyphSize = Math.min(10, Math.max(6, colW * 0.55));
	const list = rows(model, expanded.characters, expanded.worlds, expanded.resources);
	const totalH = (list.at(-1)?.y ?? HEAD_H) + (list.at(-1)?.h ?? 0);
	const columnsEnd = LEFT + beats.length * colW;
	// 少量 Beat 或手动缩小时，泳道底色与横线仍铺满可视区；数据坐标不随底色延伸。
	const totalW = Math.max(available - LABEL_W, columnsEnd + 24);
	const x = (ordinal: number) => LEFT + (ordinal - range.start) * colW;
	const cx = (ordinal: number) => x(ordinal) + colW / 2;
	const inRange = (ordinal: number) => ordinal >= range.start && ordinal <= range.end;
	const clampX = (ordinal: number) => (ordinal < range.start ? LEFT : ordinal > range.end ? columnsEnd : cx(ordinal));
	const selectedIndex = book.ordinal(selected);
	const svgRef = useRef<SVGSVGElement>(null);
	const onColumnRef = useRef(onColumn);
	onColumnRef.current = onColumn;
	const colWRef = useRef(DEFAULT_COL_W);
	colWRef.current = colW;
	const scrollRef = useRef<HTMLDivElement>(null);
	const labelDrag = useRef<{ startX: number; startW: number } | null>(null);
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) return;
		const observer = new ResizeObserver(() => setAvailable(container.clientWidth));
		observer.observe(container);
		setAvailable(container.clientWidth);
		// ⌘ / Ctrl + 滚轮（含触控板捏合）缩放列宽；普通滚轮仍是滚动。wheel 要非 passive 才能拦住浏览器缩放。
		const onWheel = (event: WheelEvent) => {
			if (!(event.metaKey || event.ctrlKey)) return;
			event.preventDefault();
			onColumnRef.current(clampColumn(colWRef.current * (event.deltaY < 0 ? 1.15 : 0.87)));
		};
		container.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			observer.disconnect();
			container.removeEventListener("wheel", onWheel);
		};
	}, []);
	// 选择改变时把对应列滚进视野，避免标记留在屏幕外。
	useEffect(() => {
		const container = scrollRef.current;
		if (!container || selectedIndex < 0 || !inRange(selectedIndex)) return;
		const left = LABEL_W + x(selectedIndex);
		const viewLeft = container.scrollLeft + LABEL_W;
		const viewRight = container.scrollLeft + container.clientWidth;
		if (left < viewLeft || left + colW > viewRight)
			container.scrollLeft = Math.max(0, left - LABEL_W - (container.clientWidth - LABEL_W) / 2);
	});
	const [dragging, setDragging] = useState(false);
	// 刷选：在列头按下并拖过至少一列；只按不拖只选择一列。
	const brush = useRef<{ start: string; moved: boolean } | null>(null);
	const [preview, setPreview] = useState<{ start: number; end: number } | null>(null);
	const brushedRange =
		preview ??
		(brushed && book.ordinal(brushed.start) >= 0 && book.ordinal(brushed.end) >= 0
			? {
					start: Math.min(book.ordinal(brushed.start), book.ordinal(brushed.end)),
					end: Math.max(book.ordinal(brushed.start), book.ordinal(brushed.end)),
				}
			: null);
	const maxFindings = Math.max(1, ...model.findings.values());
	const beatAt = (clientX: number) => {
		const rect = svgRef.current?.getBoundingClientRect();
		if (!rect) return undefined;
		const index = Math.floor((clientX - rect.left - LEFT) / colW);
		return beats[Math.max(0, Math.min(beats.length - 1, index))]?.id;
	};
	const beatTitle = (ordinal: number) => model.beats[ordinal]?.title ?? "";
	const openBeat = (ordinal: number) => open(model.beats[ordinal]?.path ?? "");
	const currentReviews = reviews.filter((report) => report.current).length;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-4 pb-2">
				{selectedIndex >= 0 && (
					<div className="flex items-center gap-2 text-xs">
						<span>{book.beatTitle(selected)}</span>
						<Button size="xs" variant="outline" onClick={() => onObserve(selected)}>
							查看此处状态
						</Button>
					</div>
				)}
				<fieldset className="m-0 flex items-center gap-0.5 border-0 p-0">
					<legend className="sr-only">缩放</legend>
					<Hint content={"缩小故事轴"}>
						<Button
							variant="outline"
							size="icon-xs"
							aria-label="缩小"
							onClick={() => onColumn(clampColumn(colW * 0.8))}
						>
							<Minus />
						</Button>
					</Hint>
					<Hint content={"放大故事轴"}>
						<Button
							variant="outline"
							size="icon-xs"
							aria-label="放大"
							onClick={() => onColumn(clampColumn(colW * 1.25))}
						>
							<Plus />
						</Button>
					</Hint>
					{/* 适应窗口是一种缩放状态，不是禁用的动作：处在这个状态时显示为按下。 */}
					<Button
						variant="outline"
						size="xs"
						className="data-[on=true]:bg-control-selected data-[on=true]:hover:bg-control-selected"
						data-on={column === null}
						aria-pressed={column === null}
						onClick={() => onColumn(null)}
					>
						适应窗口
					</Button>
				</fieldset>
				<span className="text-xs text-muted-foreground">
					审稿 {currentReviews} / {reviews.length} 份对应当前稿 · {book.currencySummary()}
				</span>
				<Button variant="outline" size="xs" onClick={onHelp}>
					图例与操作
				</Button>
				<Button
					variant="outline"
					size="xs"
					className="data-[on=true]:bg-amber-bg data-[on=true]:text-amber-ink data-[on=true]:hover:bg-amber-bg"
					data-on={showFindings}
					aria-pressed={showFindings}
					onClick={() => onToggleFindings(!showFindings)}
				>
					审稿意见密度
				</Button>
				{brushedRange && !preview && (
					<span className="flex items-center gap-2 rounded-md bg-amber-bg px-2 py-0.5 text-[11.5px] text-amber-ink">
						已选 {beatTitle(brushedRange.start)} → {beatTitle(brushedRange.end)} ·{" "}
						{brushedRange.end - brushedRange.start + 1} 个情节
						<button
							type="button"
							className="navigation-link font-medium"
							onClick={() =>
								onReference({
									start: model.beats[brushedRange.start]?.id ?? "",
									end: model.beats[brushedRange.end]?.id ?? "",
								})
							}
						>
							引用给 Agent
						</button>
						<button type="button" className="navigation-link" onClick={() => onRange(null)}>
							清除
						</button>
					</span>
				)}
			</div>
			{beats.length === 0 ? (
				<div className="m-6 rounded-lg border border-dashed border-[#d4d4d8] px-5 py-[18px] text-[12.5px] leading-[1.7] text-muted-foreground">
					还没有情节。故事轴按故事目录（outline/story/index.yaml）里的情节顺序展开；先请 Agent 做设计，或在
					outline/story 下新建情节并加进目录。
				</div>
			) : (
				<div
					ref={scrollRef}
					className="grid min-h-0 flex-1 overflow-auto"
					style={{ gridTemplateColumns: `${LABEL_W}px 1fr` }}
				>
					<div className="relative sticky left-0 z-[2] border-r border-line bg-white">
						<div
							role="slider"
							aria-label="标题列宽度"
							aria-valuenow={LABEL_W}
							aria-valuemin={MIN_LABEL_W}
							aria-valuemax={MAX_LABEL_W}
							tabIndex={0}
							className="absolute top-0 right-[-3px] z-[3] h-full w-[6px] cursor-col-resize hover:bg-[#00000012] focus-visible:bg-[#00000012]"
							onPointerDown={(event) => {
								event.currentTarget.setPointerCapture(event.pointerId);
								labelDrag.current = { startX: event.clientX, startW: LABEL_W };
							}}
							onPointerMove={(event) => {
								if (!labelDrag.current) return;
								onLabelWidth(
									Math.min(
										MAX_LABEL_W,
										Math.max(
											MIN_LABEL_W,
											labelDrag.current.startW + event.clientX - labelDrag.current.startX,
										),
									),
								);
							}}
							onPointerUp={() => {
								labelDrag.current = null;
							}}
							onKeyDown={(event) => {
								if (event.key === "ArrowLeft") onLabelWidth(Math.max(MIN_LABEL_W, LABEL_W - 16));
								if (event.key === "ArrowRight") onLabelWidth(Math.min(MAX_LABEL_W, LABEL_W + 16));
							}}
						/>
						<div
							className="flex items-end px-3.5 pb-1.5 text-[11px] text-muted-foreground"
							style={{ height: HEAD_H }}
						>
							卷 / 情节
						</div>
						{list.map((row) => (
							<Hint
								content={
									row.kind === "contract"
										? `${row.lane.path} · ${contractStatus(row.lane, model.beats.length - 1, beatTitle)}`
										: row.kind === "arcs" && model.adjacentArcs > 0
											? `其中 ${model.adjacentArcs} 条只连紧挨着的上一节，不画：相邻由列的先后表达`
											: undefined
								}
								key={row.key}
							>
								<div
									className={`flex items-center gap-1.5 overflow-hidden border-t px-3.5 text-[12px] whitespace-nowrap ${
										row.kind === "group" || row.kind === "group-toggle"
											? "border-line bg-[#fafafa] text-[11px] tracking-[.08em] text-muted-foreground"
											: "border-hair-2 text-ink-3"
									}`}
									style={{ height: row.h }}
								>
									{row.kind === "group-toggle" ? (
										<>
											<span className="truncate">{row.label}</span>
											{row.toggleLabel && (
												<button
													type="button"
													className="navigation-link ml-auto shrink-0 py-0.5 tracking-normal text-primary"
													onClick={() =>
														onExpand(row.toggle as "characters" | "worlds" | "resources", !row.on)
													}
												>
													{row.toggleLabel}
												</button>
											)}
										</>
									) : row.kind === "character" || row.kind === "world" ? (
										<>
											<i
												className={`size-2 shrink-0 ${row.kind === "world" ? "rounded-[2px]" : "rounded-full"}`}
												style={{
													background: row.kind === "world" ? "var(--muted-foreground)" : "var(--ink-2)",
												}}
											/>
											<button
												type="button"
												className="navigation-link -ml-1.5 truncate py-0.5 text-left"
												data-page={row.lane.path}
												onClick={() => open(row.lane.path)}
											>
												{row.label}
											</button>
											<small className="ml-auto text-[10.5px] text-faint tabular-nums">
												{row.lane.present.length}
											</small>
										</>
									) : row.kind === "contract" ? (
										<>
											<i className="size-2 shrink-0 rounded-[2px]" style={{ background: "var(--amber)" }} />
											<button
												type="button"
												className="navigation-link -ml-1.5 truncate py-0.5 text-left"
												data-page={row.lane.path}
												onClick={() => open(row.lane.path)}
											>
												{row.label}
											</button>
											{row.lane.late.length > 0 && (
												<small className="ml-auto text-[10.5px] text-red-ink">异常</small>
											)}
										</>
									) : (
										<span className="truncate">{row.label}</span>
									)}
								</div>
							</Hint>
						))}
					</div>
					<div>
						<svg
							ref={svgRef}
							width={totalW}
							height={totalH}
							viewBox={`0 0 ${totalW} ${totalH}`}
							role="img"
							aria-label="故事轴"
							className="block select-none"
						>
							<title>故事轴</title>
							{/* 「有正文，设计已变」画成半实心：与「正文未提交」的空心琥珀圈在白底上原来看不出区别。 */}
							<defs>
								<linearGradient id="axis-design-changed">
									<stop offset="50%" stopColor="var(--amber)" />
									<stop offset="50%" stopColor="var(--background)" />
								</linearGradient>
							</defs>
							{list
								.filter((row) => row.kind === "group" || row.kind === "group-toggle")
								.map((row) => (
									<rect
										key={`bg:${row.key}`}
										data-axis-band=""
										x={0}
										y={row.y}
										width={totalW}
										height={row.h}
										fill="var(--muted)"
									/>
								))}
							{brushedRange && brushedRange.end >= range.start && brushedRange.start <= range.end && (
								<rect
									x={clampX(brushedRange.start) - colW / 2}
									y={0}
									width={clampX(brushedRange.end) - clampX(brushedRange.start) + colW}
									height={totalH}
									fill="var(--amber)"
									opacity={0.1}
									data-range
								/>
							)}
							{list.map((row) => (
								<line
									key={row.key}
									x1={0}
									y1={row.y}
									x2={totalW}
									y2={row.y}
									stroke={
										row.kind === "group" || row.kind === "group-toggle" ? "var(--line)" : "var(--hair-2)"
									}
								/>
							))}
							{model.volumes
								.filter((volume) => volume.end >= range.start && volume.start <= range.end)
								.map((volume, index) => (
									<g key={volume.id}>
										{index > 0 && inRange(volume.start) && (
											<line
												x1={x(volume.start)}
												y1={0}
												x2={x(volume.start)}
												y2={totalH}
												stroke="var(--line)"
											/>
										)}
										{/* 使用原生文字按钮，共享导航反馈，并按实际字宽截断到本卷范围内。 */}
										<foreignObject
											x={x(Math.max(volume.start, range.start))}
											y={0}
											width={
												(Math.min(volume.end, range.end) - Math.max(volume.start, range.start) + 1) * colW
											}
											height={32}
										>
											<div className="px-0.5 py-1 text-[12px] leading-4 font-semibold text-foreground">
												<Hint
													content={`${volume.title} · ${volume.end - volume.start + 1} 个情节${
														book.data.openEnded && volume.id === model.volumes.at(-1)?.id
															? "\n全书未完待续：这一卷之后还有故事"
															: ""
													}${volume.id === entered ? "" : "\n点击进入这一卷；面包屑「故事轴」回到全书"}`}
												>
													{volume.id === entered ? (
														<span className="block truncate px-0.5 py-1" data-volume={volume.id}>
															{volume.title}
														</span>
													) : (
														<button
															type="button"
															className="navigation-link block max-w-full truncate px-0.5 text-left focus-visible:-outline-offset-1"
															data-volume={volume.id}
															onClick={(event) => {
																event.currentTarget.blur();
																onVolume(volume.id);
															}}
														>
															{volume.title}
														</button>
													)}
												</Hint>
											</div>
										</foreignObject>
									</g>
								))}
							{beats.map((beat) => (
								<g key={beat.id}>
									{/* 每个 Beat 一个空心圆作列标；id 与标题在 hover 里，列够宽时标题另行显示。 */}
									<circle
										cx={cx(beat.ordinal)}
										cy={HEAD_H - 12}
										r={Math.min(3, Math.max(1.5, colW * 0.22))}
										fill="none"
										stroke="var(--faint)"
										strokeWidth={1.2}
									/>
									{colW >= 40 && beat.title !== beat.id && (
										<text x={x(beat.ordinal) + 4} y={34} className="fill-ink-2 text-[11px] font-medium">
											{(() => {
												const max = Math.max(1, Math.floor((colW - 8) / 11));
												return beat.title.length > max
													? `${beat.title.slice(0, Math.max(1, max - 1))}…`
													: beat.title;
											})()}
										</text>
									)}
									<Hint content={`${beat.title} · ${beat.id}\n单击选择；双击打开`}>
										{/* biome-ignore lint/a11y/useSemanticElements: SVG 里没有 button 元素，列头 rect 只能声明角色 */}
										<rect
											aria-label={`${beat.title} · ${beat.id}\n单击选择；双击打开`}
											x={x(beat.ordinal)}
											y={22}
											width={colW}
											height={HEAD_H - 22}
											fill="transparent"
											data-beat={beat.id}
											{...press(() => onSelect(beat.id))}
											role="button"
											onPointerDown={(event) => {
												event.currentTarget.setPointerCapture(event.pointerId);
												brush.current = { start: beat.id, moved: false };
											}}
											onPointerMove={(event) => {
												if (!brush.current) return;
												const id = beatAt(event.clientX);
												if (!id) return;
												const a = book.ordinal(brush.current.start);
												const b = book.ordinal(id);
												if (a !== b) brush.current.moved = true;
												if (brush.current.moved) setPreview({ start: Math.min(a, b), end: Math.max(a, b) });
											}}
											onPointerUp={(event) => {
												const current = brush.current;
												brush.current = null;
												setPreview(null);
												if (!current?.moved) {
													onSelect(beat.id);
													return;
												}
												const id = beatAt(event.clientX) ?? beat.id;
												const a = book.ordinal(current.start);
												const b = book.ordinal(id);
												onRange({
													start: model.beats[Math.min(a, b)]?.id ?? "",
													end: model.beats[Math.max(a, b)]?.id ?? "",
												});
											}}
											onClick={() => {
												/* 点击由 pointerup 判断：没拖动才改变选择 */
											}}
											className="cursor-pointer outline-none hover:fill-[#00000010] focus-visible:fill-[#00000010]"
											onDoubleClick={() => open(beat.path)}
										></rect>
									</Hint>
								</g>
							))}
							{list.map((row) => {
								const midY = row.y + row.h / 2;
								if (row.kind === "coverage")
									return beats.flatMap((beat) => [
										...(beat.text === "none" && !beat.dirty
											? []
											: [
													...(showFindings && (model.findings.get(beat.ordinal) ?? 0) > 0
														? [
																<Hint
																	content={`${beat.title}：当前有效审稿的 ${model.findings.get(beat.ordinal)} 条审稿意见`}
																	key={`f:${beat.id}`}
																>
																	<rect
																		aria-label={`${beat.title}：当前有效审稿的 ${model.findings.get(beat.ordinal)} 条审稿意见`}
																		x={x(beat.ordinal)}
																		y={row.y + 1}
																		width={colW}
																		height={row.h - 1}
																		fill="var(--amber)"
																		opacity={
																			0.15 +
																			(0.55 * (model.findings.get(beat.ordinal) ?? 0)) / maxFindings
																		}
																		data-findings={model.findings.get(beat.ordinal)}
																	></rect>
																</Hint>,
															]
														: []),
													<Hint
														content={
															beat.text === "none"
																? `${beat.title}：仅有设计，尚无正文`
																: beat.text === "incompatible"
																	? `${beat.title}：已有正文，所依据的设计已有更新，请核对`
																	: `${beat.title}：${beat.dirty ? "正文有未提交修改" : "已提交正文"}`
														}
														key={`${row.key}:${beat.id}`}
													>
														<circle
															aria-label={
																beat.text === "none"
																	? `${beat.title}：仅有设计，尚无正文`
																	: beat.text === "incompatible"
																		? `${beat.title}：已有正文，所依据的设计已有更新，请核对`
																		: `${beat.title}：${beat.dirty ? "正文有未提交修改" : "已提交正文"}`
															}
															cx={cx(beat.ordinal)}
															cy={midY}
															r={dotR}
															fill={
																beat.text === "committed"
																	? "var(--success)"
																	: beat.text === "incompatible"
																		? "url(#axis-design-changed)"
																		: "none"
															}
															stroke={
																beat.text === "committed"
																	? "var(--success)"
																	: beat.text === "incompatible" || beat.dirty
																		? "var(--amber)"
																		: "var(--faint)"
															}
															strokeWidth={1.5}
															{...press(() => open(beat.textPath ?? beat.path))}
														></circle>
													</Hint>,
												]),
									]);
								if (row.kind === "review")
									return beats.flatMap((beat) => {
										const reports = model.reviews.get(beat.ordinal);
										const latest = reports?.at(-1);
										if (!reports || !latest) return [];
										const c = cx(beat.ordinal);
										const color = verdictColor(latest.verdict);
										return [
											<Hint
												content={`${verdictLabel(latest.verdict)} · ${reviewCurrencyLabel(latest.current)} · ${latest.findings} 条审稿意见${reports.length > 1 ? `\n共 ${reports.length} 份报告` : ""}`}
												key={`${row.key}:${beat.id}`}
											>
												<g
													aria-label={`${verdictLabel(latest.verdict)} · ${reviewCurrencyLabel(latest.current)} · ${latest.findings} 条审稿意见${reports.length > 1 ? `\n共 ${reports.length} 份报告` : ""}`}
													{...press(() => open(issuePage(latest.reportId)))}
												>
													<polygon
														points={`${c},${midY - 5} ${c + 5},${midY + 4} ${c - 5},${midY + 4}`}
														fill={latest.current ? color : "#fff"}
														stroke={color}
														strokeWidth={1.5}
													/>
													{reports.length > 1 && (
														<text
															x={c + 7}
															y={midY + 4}
															className="fill-muted-foreground text-[9.5px] tabular-nums"
														>
															{reports.length}
														</text>
													)}
												</g>
											</Hint>,
										];
									});
								if (row.kind === "spans")
									return model.spans
										.filter((span) => span.end >= range.start && span.start <= range.end)
										.map((span, index) => {
											const y = row.y + 13 + index * 8;
											const color = verdictColor(span.verdict);
											return (
												<Hint
													content={`${span.layer === "text" ? "正文审稿" : span.layer === "design" ? "设计审稿" : span.layer} · ${verdictLabel(span.verdict)} · ${reviewCurrencyLabel(span.current)} · ${span.findings} 条审稿意见\n覆盖 ${beatTitle(span.start)} → ${beatTitle(span.end)}`}
													key={span.reportId}
												>
													<line
														aria-label={`${span.layer === "text" ? "正文审稿" : span.layer === "design" ? "设计审稿" : span.layer} · ${verdictLabel(span.verdict)} · ${reviewCurrencyLabel(span.current)} · ${span.findings} 条审稿意见\n覆盖 ${beatTitle(span.start)} → ${beatTitle(span.end)}`}
														x1={clampX(span.start)}
														y1={y}
														x2={clampX(span.end)}
														y2={y}
														stroke={color}
														strokeWidth={2}
														strokeDasharray={span.current ? undefined : "3 3"}
														strokeLinecap="round"
														opacity={span.current ? 0.45 : 0.25}
														{...press(() => open(issuePage(span.reportId)))}
													></line>
												</Hint>
											);
										});
								if (row.kind === "arcs") {
									const base = row.y + row.h - 6;
									const isRelated = (arc: { from: number; to: number }) =>
										selectedIndex >= 0 && (arc.from === selectedIndex || arc.to === selectedIndex);
									// 选中 Beat 的弧排在最后，画在最上层。
									const visible = model.arcs
										.filter((arc) => arc.to >= range.start && arc.from <= range.end)
										.sort((a, b) => Number(isRelated(a)) - Number(isRelated(b)));
									const opacity = arcOpacity(visible.length);
									return (
										<g key="arcs">
											<clipPath id={arcClip}>
												<rect x={LEFT} y={row.y} width={Math.max(0, columnsEnd - LEFT)} height={row.h} />
											</clipPath>
											{/* 进卷时，一端在卷外的弧按真实位置画、在边界裁掉，不收到边上：收到边上会像都依赖卷首那一节。 */}
											<g clipPath={`url(#${arcClip})`}>
												{visible.map((arc) => {
													const xa = cx(arc.from);
													const xb = cx(arc.to);
													// 三次贝塞尔的顶点在控制点高度的 3/4 处，控制点抬高 4/3 让弧顶正好是 h。
													const lift =
														(arcHeight(arc.to - arc.from, maxArcSpan, xb - xa, row.h - 12) * 4) / 3;
													const related = isRelated(arc);
													return (
														<Hint
															content={`因果依赖：${beatTitle(arc.to)} 依赖 ${beatTitle(arc.from)}，跨 ${arc.to - arc.from} 个情节`}
															key={`${arc.from}-${arc.to}`}
														>
															<path
																aria-label={`因果依赖：${beatTitle(arc.to)} 依赖 ${beatTitle(arc.from)}，跨 ${arc.to - arc.from} 个情节`}
																d={`M${xa} ${base} C ${xa} ${base - lift}, ${xb} ${base - lift}, ${xb} ${base}`}
																fill="none"
																stroke="var(--purple)"
																strokeWidth={related ? 2 : 1}
																opacity={selectedIndex < 0 ? opacity : related ? 1 : opacity * 0.3}
																data-arc={`${arc.from}-${arc.to}`}
																{...press(() => openBeat(arc.to))}
															></path>
														</Hint>
													);
												})}
											</g>
										</g>
									);
								}
								if (row.kind === "character") {
									const lane = row.lane;
									return [
										...lane.present
											.filter((ordinal) => inRange(ordinal))
											.map((ordinal) => {
												const gone = lane.deadAt >= 0 && ordinal > lane.deadAt;
												return (
													<Hint
														content={`${lane.title} · ${beatTitle(ordinal)}\n此处的情节设计引用了此人物${gone ? "；此时已死亡，仍被引用（回忆或遗产）" : ""}`}
														key={`p:${ordinal}`}
													>
														<circle
															aria-label={`${lane.title} · ${beatTitle(ordinal)}\n此处的情节设计引用了此人物${gone ? "；此时已死亡，仍被引用（回忆或遗产）" : ""}`}
															cx={cx(ordinal)}
															cy={midY}
															r={Math.min(3.5, dotR * 0.8)}
															fill={gone ? "none" : "var(--muted-foreground)"}
															stroke="var(--muted-foreground)"
															strokeWidth={1.4}
															{...press(() => openBeat(ordinal))}
														></circle>
													</Hint>
												);
											}),
										...lane.events
											.filter((event) => inRange(event.ordinal))
											.map((event) => {
												const present = lane.present.includes(event.ordinal);
												return (
													<Hint
														content={`${lane.title} · ${beatTitle(event.ordinal)}\n${event.note}`}
														key={`e:${event.kind}:${event.ordinal}`}
													>
														<text
															aria-label={`${lane.title} · ${beatTitle(event.ordinal)}\n${event.note}`}
															x={cx(event.ordinal) + (present ? 6 : 0)}
															y={midY + 4}
															textAnchor={present ? "start" : "middle"}
															fontSize={glyphSize}
															fill={
																event.kind === "dead"
																	? "var(--destructive)"
																	: event.kind === "secret"
																		? "var(--purple)"
																		: "var(--muted-foreground)"
															}
															{...press(() => openBeat(event.ordinal))}
														>
															{event.kind === "dead" ? "✕" : event.kind === "secret" ? "◆" : "⌖"}
														</text>
													</Hint>
												);
											}),
									];
								}
								if (row.kind === "resource") {
									const lane = row.lane;
									const last = lane.events.at(-1);
									const end =
										last && (last.kind === "consumed" || last.kind === "destroyed")
											? last.ordinal
											: model.beats.length - 1;
									return [
										<Hint
											content={`${lane.title}${lane.initialHolder ? `：开场持有者 ${lane.initialHolder}` : ""}`}
											key="track"
										>
											<line
												aria-label={`${lane.title}${lane.initialHolder ? `：开场持有者 ${lane.initialHolder}` : ""}`}
												x1={clampX(0)}
												y1={midY}
												x2={clampX(end)}
												y2={midY}
												stroke="var(--muted-foreground)"
												strokeWidth={1}
												strokeDasharray="2 3"
												opacity={0.6}
											></line>
										</Hint>,
										...lane.events
											.filter((event) => inRange(event.ordinal))
											.map((event) => (
												<Hint
													content={`${lane.title} · ${beatTitle(event.ordinal)}\n${event.kind === "holder" ? `持有者改为：${event.value}` : event.kind === "location" ? `位置改为：${event.value}` : event.kind === "destroyed" ? "资源已毁坏" : "资源已消耗"}`}
													key={`${event.kind}:${event.ordinal}`}
												>
													<g
														aria-label={`${lane.title} · ${beatTitle(event.ordinal)}\n${event.kind === "holder" ? `持有者改为：${event.value}` : event.kind === "location" ? `位置改为：${event.value}` : event.kind === "destroyed" ? "资源已毁坏" : "资源已消耗"}`}
														{...press(() => openBeat(event.ordinal))}
													>
														{event.kind === "holder" || event.kind === "location" ? (
															<circle
																cx={cx(event.ordinal)}
																cy={midY}
																r={Math.min(4, dotR * 0.9)}
																fill={event.kind === "holder" ? "var(--primary)" : "#fff"}
																stroke="var(--primary)"
																strokeWidth={1.5}
															/>
														) : (
															<text
																x={cx(event.ordinal)}
																y={midY + 4}
																textAnchor="middle"
																fontSize={11}
																fill="var(--destructive)"
															>
																✕
															</text>
														)}
														{colW >= 40 && event.value && (
															<text
																x={cx(event.ordinal) + 7}
																y={midY + 4}
																fontSize={10}
																className="fill-ink-3"
															>
																{event.value.slice(0, 6)}
															</text>
														)}
													</g>
												</Hint>
											)),
									];
								}
								if (row.kind === "world")
									return row.lane.present
										.filter((ordinal) => inRange(ordinal))
										.map((ordinal) => (
											<Hint
												content={`${row.lane.title} · ${beatTitle(ordinal)}\n此处的情节设计引用了此世界设定`}
												key={`w:${ordinal}`}
											>
												<rect
													aria-label={`${row.lane.title} · ${beatTitle(ordinal)}\n此处的情节设计引用了此世界设定`}
													x={cx(ordinal) - 3.5}
													y={midY - 3.5}
													width={7}
													height={7}
													rx={1.5}
													fill="var(--muted-foreground)"
													{...press(() => openBeat(ordinal))}
												></rect>
											</Hint>
										));
								if (row.kind !== "contract") return null;
								const lane = row.lane;
								const first = lane.open[0] ?? lane.advance[0] ?? 0;
								const last =
									lane.resolve[0] ?? (lane.deadlineIndex >= 0 ? lane.deadlineIndex : model.beats.length - 1);
								return (
									<g key={row.key}>
										{first <= range.end && last >= range.start && (
											<Hint
												content={`${lane.title}：建立 ${lane.open.length} 次 · 推进 ${lane.advance.length} 次 · ${lane.resolve.length ? "已回应" : "尚未回应"}\n回应期限：${lane.deadline === "book_end" ? book.bookEndLabel : lane.deadline ? book.beatTitle(lane.deadline) : "未设置"}\n涉及对象：${lane.subjects.join("、") || "未设置"}`}
											>
												<line
													aria-label={`${lane.title}：建立 ${lane.open.length} 次 · 推进 ${lane.advance.length} 次 · ${lane.resolve.length ? "已回应" : "尚未回应"}\n回应期限：${lane.deadline === "book_end" ? book.bookEndLabel : lane.deadline ? book.beatTitle(lane.deadline) : "未设置"}\n涉及对象：${lane.subjects.join("、") || "未设置"}`}
													x1={clampX(first)}
													y1={midY}
													x2={clampX(last)}
													y2={midY}
													stroke="var(--amber)"
													strokeWidth={lane.resolve.length ? 2 : 1.5}
													strokeDasharray={lane.resolve.length ? undefined : "4 3"}
													opacity={0.8}
												></line>
											</Hint>
										)}
										{lane.deadlineIndex >= 0 && inRange(lane.deadlineIndex) && (
											<Hint
												content={`回应期限：${lane.deadline === "book_end" ? book.bookEndLabel : book.beatTitle(lane.deadline ?? "")}`}
											>
												<line
													aria-label={`回应期限：${lane.deadline === "book_end" ? book.bookEndLabel : book.beatTitle(lane.deadline ?? "")}`}
													x1={cx(lane.deadlineIndex)}
													y1={midY - 9}
													x2={cx(lane.deadlineIndex)}
													y2={midY + 9}
													stroke="var(--amber)"
													strokeWidth={1.5}
												></line>
											</Hint>
										)}
										{lane.advance
											.filter((ordinal) => inRange(ordinal))
											.map((ordinal) => (
												<Hint
													content={`推进期待 · ${beatTitle(ordinal)}${lane.late.includes(ordinal) ? "\n此前已有回应，之后仍有推进记录，请核对" : ""}`}
													key={`a:${ordinal}`}
												>
													<circle
														aria-label={`推进期待 · ${beatTitle(ordinal)}${lane.late.includes(ordinal) ? "\n此前已有回应，之后仍有推进记录，请核对" : ""}`}
														cx={cx(ordinal)}
														cy={midY}
														r={Math.min(3, dotR * 0.7)}
														fill={lane.late.includes(ordinal) ? "var(--destructive)" : "var(--amber)"}
														{...press(() => openBeat(ordinal))}
													></circle>
												</Hint>
											))}
										{(["open", "resolve"] as const).flatMap((kind) =>
											lane[kind]
												.filter((ordinal) => inRange(ordinal))
												.map((ordinal) => (
													<Hint
														content={`${kind === "open" ? "建立期待" : "回应期待"} · ${beatTitle(ordinal)}`}
														key={`${kind}:${ordinal}`}
													>
														<rect
															aria-label={`${kind === "open" ? "建立期待" : "回应期待"} · ${beatTitle(ordinal)}`}
															x={cx(ordinal) - dotR}
															y={midY - dotR}
															width={dotR * 2}
															height={dotR * 2}
															rx={2}
															fill="var(--amber)"
															{...press(() => openBeat(ordinal))}
														></rect>
													</Hint>
												)),
										)}
									</g>
								);
							})}
							{selectedIndex >= 0 && inRange(selectedIndex) && (
								<g>
									<line
										x1={cx(selectedIndex)}
										y1={HEAD_H}
										x2={cx(selectedIndex)}
										y2={totalH}
										stroke="var(--primary)"
										strokeWidth={1.5}
									/>
									<Hint content={`当前情节：${book.beatTitle(selected)}\n拖动或按左右方向键切换`}>
										<rect
											x={cx(selectedIndex) - 6}
											y={HEAD_H - 5}
											width={12}
											height={10}
											rx={2}
											fill="var(--primary)"
											className="cursor-ew-resize"
											role="slider"
											aria-label="选中情节"
											aria-valuenow={selectedIndex}
											aria-valuemin={range.start}
											aria-valuemax={range.end}
											tabIndex={0}
											onPointerDown={(event) => {
												event.currentTarget.setPointerCapture(event.pointerId);
												setDragging(true);
											}}
											onPointerMove={(event) => {
												if (!dragging) return;
												const id = beatAt(event.clientX);
												if (id && id !== selected) onSelect(id);
											}}
											onPointerUp={() => setDragging(false)}
											onKeyDown={(event) => {
												const next =
													event.key === "ArrowRight"
														? selectedIndex + 1
														: event.key === "ArrowLeft"
															? selectedIndex - 1
															: -1;
												const target = model.beats[next];
												if (target) onSelect(target.id);
											}}
										></rect>
									</Hint>
								</g>
							)}
						</svg>
					</div>
				</div>
			)}
		</div>
	);
}
