import { type Book, KIND_LABEL } from "../model.js";

/**
 * 邻域数据：以一份 artifact 为中心，左列是它依赖的，右列是依赖它的，按 kind 分组。
 * 边全部来自 frontmatter 派生的 links，键名就是边的说明。纯函数，渲染在 Neighborhood.tsx。
 */
export interface NeighborNode {
	path: string;
	title: string;
	kind: string;
	/** 边的说明：frontmatter 键，或 text / 实现 这类固定关系。 */
	key: string;
}
export interface NeighborGroup {
	kind: string;
	label: string;
	items: NeighborNode[];
}
export interface Neighborhood {
	up: NeighborGroup[];
	down: NeighborGroup[];
}

const KIND_ORDER = [
	"story-beat",
	"story-text",
	"story-contract",
	"character",
	"world",
	"place",
	"resource",
	"intent",
	"style-evidence",
];

function grouped(book: Book, nodes: NeighborNode[]): NeighborGroup[] {
	const groups = new Map<string, NeighborGroup>();
	for (const node of nodes) {
		const group = groups.get(node.kind) ?? { kind: node.kind, label: KIND_LABEL[node.kind] ?? node.kind, items: [] };
		if (!group.items.some((item) => item.path === node.path && item.key === node.key)) group.items.push(node);
		groups.set(node.kind, group);
	}
	for (const group of groups.values())
		if (group.kind === "story-beat" || group.kind === "story-text")
			group.items.sort(
				(a, b) =>
					book.ordinal(book.byPath.get(a.path)?.localId ?? "") -
					book.ordinal(book.byPath.get(b.path)?.localId ?? ""),
			);
	return [...groups.values()].sort(
		(a, b) => (KIND_ORDER.indexOf(a.kind) + 1 || 99) - (KIND_ORDER.indexOf(b.kind) + 1 || 99),
	);
}

export function neighborhoodFor(book: Book, path: string): Neighborhood {
	const file = book.byPath.get(path);
	const node = (target: string, key: string): NeighborNode | undefined => {
		const entry = book.byPath.get(target);
		return entry ? { path: entry.path, title: book.title(entry), kind: entry.kind, key } : undefined;
	};
	const up: NeighborNode[] = [];
	const down: NeighborNode[] = [];
	for (const link of book.links) {
		if (link.from === path) {
			const target = node(link.to, link.key);
			if (target) up.push(target);
		}
		if (link.to === path) {
			const source = node(link.from, link.key);
			if (source) down.push(source);
		}
	}
	if (file?.kind === "story-beat") {
		const text = book.text(file.localId);
		if (text) down.push({ path: text.path, title: book.title(text), kind: text.kind, key: "text/ 同 id 实现" });
	}
	if (file?.kind === "story-text") {
		const beat = book.beat(file.localId);
		if (beat) up.push({ path: beat.path, title: book.title(beat), kind: beat.kind, key: "这篇正文的情节设计" });
	}
	return { up: grouped(book, up), down: grouped(book, down) };
}
