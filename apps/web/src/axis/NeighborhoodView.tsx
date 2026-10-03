import { type Book, KIND_COLOR, KIND_LABEL } from "../model.js";
import { Hint } from "../ui-bits.js";
import { type NeighborGroup, type NeighborNode, neighborhoodFor } from "./neighborhood.js";

/**
 * 邻域图：三列布局——左列是它依赖的，右列是依赖它的；点任一节点打开它，关系模式下就成了新的中心。
 * 取代把一跳节点均匀摆在圆上的结构图：圆不表达方向，超过二十个节点就重叠。
 */
const NODE_W = 180;
const NODE_H = 28;
const GAP = 6;
const GROUP_GAP = 14;
const MAX_PER_GROUP = 8;
const COL = { up: 0, center: 262, down: 524 };
const WIDTH = 704;
// 两端节点贴近绘图区边缘，为向外延伸的描边保留空间，避免圆角被画布裁切。
const STROKE_PADDING = 1;

type Placed =
	| { type: "group"; y: number; label: string; count: number }
	| { type: "node"; y: number; node: NeighborNode }
	| { type: "more"; y: number; count: number };

function place(groups: NeighborGroup[], expandedKinds: Set<string>): { items: Placed[]; height: number } {
	const items: Placed[] = [];
	let y = 40;
	for (const group of groups) {
		items.push({ type: "group", y, label: group.label, count: group.items.length });
		y += 16;
		const shown = expandedKinds.has(group.kind) ? group.items : group.items.slice(0, MAX_PER_GROUP);
		for (const node of shown) {
			items.push({ type: "node", y, node });
			y += NODE_H + GAP;
		}
		if (shown.length < group.items.length) {
			items.push({ type: "more", y, count: group.items.length - shown.length });
			y += 22;
		}
		y += GROUP_GAP;
	}
	return { items, height: y };
}

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
	const file = book.byPath.get(path);
	const { up, down } = neighborhoodFor(book, path);
	const left = place(up, expandedKinds);
	const right = place(down, expandedKinds);
	const height = Math.max(200, left.height, right.height) + 16;
	const cy = height / 2;
	const upCount = up.reduce((sum, group) => sum + group.items.length, 0);
	const downCount = down.reduce((sum, group) => sum + group.items.length, 0);
	const label = (text: string, max = 12) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
	const color = (kind: string) => KIND_COLOR[kind] ?? "#71717a";
	const column = (placed: Placed[], side: "up" | "down") =>
		placed.map((item) => {
			const x = COL[side];
			if (item.type === "group")
				return (
					<text
						key={`g:${side}:${item.y}`}
						x={x}
						y={item.y}
						className="fill-muted-foreground text-[10.5px] tracking-[.08em]"
					>
						{item.label.toUpperCase()} · {item.count}
					</text>
				);
			if (item.type === "more") {
				const kind = placed.find((entry) => entry.type === "node" && entry.y < item.y);
				const kindId = kind?.type === "node" ? kind.node.kind : "";
				return (
					<foreignObject key={`m:${side}:${item.y}`} x={x} y={item.y - 4} width={NODE_W} height={28}>
						<div className="p-1">
							<button
								type="button"
								className="navigation-link block max-w-full truncate py-0.5 text-[11px] leading-4 text-primary"
								onClick={() => onExpand(kindId)}
							>
								还有 {item.count} 项，展开
							</button>
						</div>
					</foreignObject>
				);
			}
			const node = item.node;
			const x1 = side === "up" ? x + NODE_W : COL.center;
			const x2 = side === "up" ? COL.center : x;
			const y1 = item.y + NODE_H / 2;
			const midX = (x1 + x2) / 2;
			const d =
				side === "up"
					? `M${x1} ${y1} C ${midX} ${y1}, ${midX} ${cy}, ${x2} ${cy}`
					: `M${x1} ${cy} C ${midX} ${cy}, ${midX} ${y1}, ${x2} ${y1}`;
			const text =
				node.kind === "story-beat" || node.kind === "story-text" ? `${label(node.title, 13)}` : label(node.title);
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
								if (event.key === "Enter") open(node.path);
							}}
						>
							<rect
								x={x}
								y={item.y}
								width={NODE_W}
								height={NODE_H}
								rx={5}
								fill="var(--card)"
								stroke="var(--line)"
							/>
							<circle cx={x + 11} cy={y1} r={3.5} fill={color(node.kind)} />
							<text x={x + 21} y={y1 + 4} className="fill-foreground text-[12px]">
								{text}
							</text>
						</g>
					</Hint>
				</g>
			);
		});
	return (
		<div className="overflow-x-auto" data-neighborhood>
			<svg
				width={WIDTH + STROKE_PADDING * 2}
				height={height}
				viewBox={`${-STROKE_PADDING} 0 ${WIDTH + STROKE_PADDING * 2} ${height}`}
				role="img"
				aria-label="邻域图"
				className="block"
			>
				<title>邻域图</title>
				<text x={COL.up} y={20} className="fill-muted-foreground text-[11px] tracking-[.1em]">
					它依赖的 · {upCount}
				</text>
				<text x={COL.center} y={20} className="fill-muted-foreground text-[11px] tracking-[.1em]">
					当前
				</text>
				<text x={COL.down} y={20} className="fill-muted-foreground text-[11px] tracking-[.1em]">
					依赖它的 · {downCount}
				</text>
				{column(left.items, "up")}
				{column(right.items, "down")}
				<g>
					<rect
						x={COL.center}
						y={cy - 22}
						width={NODE_W}
						height={44}
						rx={6}
						fill="var(--primary-soft)"
						stroke="var(--primary)"
						strokeWidth={1.5}
					/>
					<text x={COL.center + 10} y={cy - 3} className="fill-foreground text-[12.5px] font-semibold">
						{label(book.title(file), 14)}
					</text>
					<text x={COL.center + 10} y={cy + 13} className="fill-muted-foreground text-[10.5px]">
						{KIND_LABEL[file?.kind ?? ""] ?? file?.kind} · {file?.localId}
					</text>
				</g>
			</svg>
			{upCount + downCount === 0 && (
				<p className="mt-2 text-xs text-muted-foreground">
					这份 artifact 的 frontmatter 没有引用别的 artifact，也没有被引用。
				</p>
			)}
		</div>
	);
}
