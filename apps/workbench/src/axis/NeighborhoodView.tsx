import { useEffect, useRef, useState } from "react";
import { type Book, KIND_COLOR, KIND_LABEL } from "../model.js";
import { Hint } from "../ui-bits.js";
import { type NeighborGroup, type NeighborNode, neighborhoodFor } from "./neighborhood.js";

const GAP = 6;
const GROUP_GAP = 14;
const MAX_PER_GROUP = 8;
// 不缩小文字来塞进窄窗；极窄分屏保留可滚动的图。空方向不预留整列。
const COLUMN_GAP = 48;
const STROKE_PADDING = 1;
const linesOf = (text: string, width: number): string[] => {
	const chars = Array.from(text);
	const size = Math.max(1, Math.floor((width - 28) / 12));
	return Array.from({ length: Math.max(1, Math.ceil(chars.length / size)) }, (_, i) =>
		chars.slice(i * size, (i + 1) * size).join(""),
	);
};
type Placed =
	| { type: "group"; y: number; label: string; count: number }
	| { type: "node"; y: number; height: number; lines: string[]; node: NeighborNode }
	| { type: "more"; y: number; count: number; kind: string };

function place(
	groups: NeighborGroup[],
	expandedKinds: Set<string>,
	width: number,
): { items: Placed[]; height: number } {
	const items: Placed[] = [];
	let y = 40;
	for (const group of groups) {
		items.push({ type: "group", y, label: group.label, count: group.items.length });
		y += 16;
		const shown = expandedKinds.has(group.kind) ? group.items : group.items.slice(0, MAX_PER_GROUP);
		for (const node of shown) {
			const lines = linesOf(node.title, width);
			const height = Math.max(28, lines.length * 16 + 10);
			items.push({ type: "node", y, height, lines, node });
			y += height + GAP;
		}
		if (shown.length < group.items.length) {
			items.push({ type: "more", y, count: group.items.length - shown.length, kind: group.kind });
			y += 28;
		}
		y += GROUP_GAP;
	}
	return { items, height: y };
}

/** 保留以当前对象为中心的节点与连线，随实际容器分配列宽；标题换行后重新排布节点。 */
export function NeighborhoodView({
	book,
	path,
	open,
	expandedKinds,
	onExpand,
}: {
	book: Book;
	path: string;
	open(page: string): void;
	expandedKinds: Set<string>;
	onExpand(kind: string): void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const [available, setAvailable] = useState(704);
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const observer = new ResizeObserver(() => setAvailable(element.clientWidth));
		setAvailable(element.clientWidth);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const file = book.byPath.get(path);
	const { up, down } = neighborhoodFor(book, path);
	const upCount = up.reduce((sum, group) => sum + group.items.length, 0);
	const downCount = down.reduce((sum, group) => sum + group.items.length, 0);
	const columns = 1 + Number(upCount > 0) + Number(downCount > 0);
	const nodeWidth = Math.min(
		240,
		Math.max(180, (available - STROKE_PADDING * 2 - COLUMN_GAP * (columns - 1)) / columns),
	);
	const step = nodeWidth + COLUMN_GAP;
	const col = { up: 0, center: upCount > 0 ? step : 0, down: upCount > 0 ? step * 2 : step };
	const width = columns * nodeWidth + (columns - 1) * COLUMN_GAP;
	const left = place(up, expandedKinds, nodeWidth);
	const right = place(down, expandedKinds, nodeWidth);
	const centerLines = linesOf(book.title(file), nodeWidth);
	const centerHeight = centerLines.length * 16 + 30;
	const height = Math.max(180, left.height, right.height, centerHeight + 64) + 16;
	const cy = height / 2;
	const color = (kind: string) => KIND_COLOR[kind] ?? "var(--muted-foreground)";
	const column = (placed: Placed[], side: "up" | "down") =>
		placed.map((item) => {
			const x = col[side];
			if (item.type === "group")
				return (
					<text
						key={`g:${side}:${item.y}`}
						x={x}
						y={item.y}
						className="fill-muted-foreground text-[10.5px] tracking-[.08em]"
					>
						{item.label} · {item.count}
					</text>
				);
			if (item.type === "more")
				return (
					<foreignObject key={`m:${side}:${item.y}`} x={x} y={item.y - 4} width={nodeWidth} height={32}>
						<div className="p-1">
							<button
								type="button"
								className="navigation-link block max-w-full truncate py-0.5 text-[11px] leading-4 text-primary"
								onClick={() => onExpand(item.kind)}
							>
								还有 {item.count} 项，展开
							</button>
						</div>
					</foreignObject>
				);
			const node = item.node;
			const x1 = side === "up" ? x + nodeWidth : col.center + nodeWidth;
			const x2 = side === "up" ? col.center : x;
			const y1 = item.y + item.height / 2;
			const midX = (x1 + x2) / 2;
			const d =
				side === "up"
					? `M${x1} ${y1} C ${midX} ${y1}, ${midX} ${cy}, ${x2} ${cy}`
					: `M${x1} ${cy} C ${midX} ${cy}, ${midX} ${y1}, ${x2} ${y1}`;
			return (
				<g key={`n:${side}:${node.path}:${node.key}`}>
					<path d={d} fill="none" stroke={color(node.kind)} strokeWidth={1.2} opacity={0.75} />
					<Hint content={`${node.title}\n${KIND_LABEL[node.kind] ?? node.kind}\n引用字段：${node.key}`}>
						{/* biome-ignore lint/a11y/useSemanticElements: SVG 里没有 button 元素 */}
						<g
							aria-label={`${node.title}\n${KIND_LABEL[node.kind] ?? node.kind}\n引用字段：${node.key}`}
							role="button"
							tabIndex={0}
							className="cursor-pointer outline-none [&:hover>rect]:stroke-ink-3 focus-visible:[&>rect]:stroke-ring"
							data-page={node.path}
							onClick={() => open(node.path)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									open(node.path);
								}
							}}
						>
							<rect
								x={x}
								y={item.y}
								width={nodeWidth}
								height={item.height}
								rx={5}
								fill="var(--card)"
								stroke="var(--line)"
							/>
							<circle cx={x + 11} cy={y1} r={3.5} fill={color(node.kind)} />
							<text className="fill-foreground text-[12px]">
								{item.lines.map((line, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: 只读标题换行，行号区分重复片段。
									<tspan key={`${index}:${line}`} x={x + 21} y={item.y + 18 + index * 16}>
										{line}
									</tspan>
								))}
							</text>
						</g>
					</Hint>
				</g>
			);
		});
	return (
		<div ref={root} className="overflow-x-auto" data-neighborhood>
			{/* biome-ignore lint/a11y/useSemanticElements: SVG 图包含可操作节点，不能用 img 隐藏子节点，也不能替换成 fieldset。 */}
			<svg
				width={width + STROKE_PADDING * 2}
				height={height}
				viewBox={`${-STROKE_PADDING} 0 ${width + STROKE_PADDING * 2} ${height}`}
				role="group"
				aria-label="邻域图"
				className="block"
			>
				<title>邻域图</title>
				{upCount > 0 && (
					<text x={col.up} y={20} className="fill-muted-foreground text-[11px] tracking-[.1em]">
						它依赖的 · {upCount}
					</text>
				)}
				<text x={col.center} y={20} className="fill-muted-foreground text-[11px] tracking-[.1em]">
					当前
				</text>
				{downCount > 0 && (
					<text x={col.down} y={20} className="fill-muted-foreground text-[11px] tracking-[.1em]">
						依赖它的 · {downCount}
					</text>
				)}
				{column(left.items, "up")}
				{column(right.items, "down")}
				<g>
					<title>{book.title(file)}</title>
					<rect
						x={col.center}
						y={cy - centerHeight / 2}
						width={nodeWidth}
						height={centerHeight}
						rx={6}
						fill="var(--primary-soft)"
						stroke="var(--primary)"
						strokeWidth={1.5}
					/>
					<text className="fill-foreground text-[12px] font-semibold">
						{centerLines.map((line, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 只读标题换行，行号区分重复片段。
							<tspan key={`${index}:${line}`} x={col.center + 10} y={cy - centerHeight / 2 + 18 + index * 16}>
								{line}
							</tspan>
						))}
					</text>
					<text x={col.center + 10} y={cy + centerHeight / 2 - 8} className="fill-muted-foreground text-[10.5px]">
						{KIND_LABEL[file?.kind ?? ""] ?? file?.kind}
					</text>
				</g>
			</svg>
			{upCount + downCount === 0 && <p className="mt-2 text-xs text-muted-foreground">这份文档没有关联记录。</p>}
		</div>
	);
}
