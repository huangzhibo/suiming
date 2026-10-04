import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { yaml, yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
	getChunks,
	getOriginalDoc,
	type MergeConfig,
	MergeView,
	originalDocChangeEffect,
	unifiedMergeView,
} from "@codemirror/merge";
import { Annotation, ChangeSet, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { ComparisonResizer } from "./comparison-resizer.js";
import type { ComparisonLayout, EditorPosition } from "./view-state.js";

export interface ComparisonStatus {
	count: number;
	active: number;
}
export interface ComparisonController {
	next(): void;
	previous(): void;
	restore(): void;
}
export interface ComparisonConfig {
	layout: ComparisonLayout;
	controller: RefObject<ComparisonController | null>;
	onStatus(value: ComparisonStatus | null): void;
	before: ReactNode;
	after: ReactNode;
	ratio: number;
	onRatio(value: number): void;
	sync: boolean;
	changesOnly: boolean;
}

function selectedChunk(view: EditorView | undefined): number {
	if (!view) return -1;
	const diff = getChunks(view.state);
	const head = view.state.selection.main.head;
	return (
		diff?.chunks.findIndex((chunk) =>
			diff.side === "a" ? head >= chunk.fromA && head <= chunk.endA : head >= chunk.fromB && head <= chunk.endB,
		) ?? -1
	);
}

const unifiedExtensions = (original: string, changesOnly: boolean) =>
	unifiedMergeView({
		original,
		mergeControls: false,
		allowInlineDiffs: false,
		...(changesOnly ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {}),
	});

const externalChange = Annotation.define<boolean>();

/** Markdown 源码即真源：只做语法着色，不隐藏标记；标题、强调、链接用与阅读态相同的语义色。 */
const highlight = HighlightStyle.define([
	{ tag: tags.heading, fontWeight: "600" },
	{ tag: tags.strong, fontWeight: "600" },
	{ tag: tags.emphasis, color: "var(--purple)" },
	{ tag: tags.link, textDecoration: "underline" },
	{ tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.9em" },
	{ tag: tags.processingInstruction, color: "var(--faint)" },
	{ tag: tags.meta, color: "var(--faint)" },
	{ tag: [tags.keyword, tags.propertyName], color: "var(--primary)" },
]);
/** 中文长文的排版：宋体 16px / 28px 行高，软换行，不显示行号。 */
const theme = EditorView.theme({
	"&": { height: "100%", fontSize: "16px", backgroundColor: "#fff" },
	".cm-scroller": { fontFamily: "inherit", lineHeight: "28px", padding: "24px 0" },
	".cm-content": {
		padding: "0 var(--page-gutter)",
		maxWidth: "var(--editor-max-width, none)",
		margin: "0 auto",
		caretColor: "var(--foreground)",
	},
	".cm-line": { padding: "0" },
	"&.cm-focused": { outline: "none" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--primary-selection)" },
	".cm-mergeView &": { fontSize: "14.5px" },
	".cm-mergeView & .cm-scroller": { lineHeight: "24px" },
	".cm-mergeView & .cm-content": { padding: "0 20px" },
});
/** merge 视图的回退控件与分栏线：控件要能一眼看到并点中。 */
const mergeTheme = EditorView.baseTheme({
	".cm-merge-revert": { width: "28px" },
	".cm-merge-revert button": {
		fontSize: "16px",
		lineHeight: "24px",
		color: "var(--primary)",
		cursor: "pointer",
		padding: "0 4px",
	},
	".cm-merge-revert button:hover": { background: "var(--primary-soft)", borderRadius: "4px" },
});
const language = (path: string): Extension =>
	path.endsWith(".yaml") ? yaml() : yamlFrontmatter({ content: markdown() });
const base = (path: string): Extension[] => [
	language(path),
	syntaxHighlighting(highlight),
	theme,
	mergeTheme,
	EditorView.lineWrapping,
	EditorState.tabSize.of(2),
	EditorState.phrases.of({ "$ unchanged lines": "已折叠 $ 行未修改内容" }),
];

/** 把视图内容整体换成 next；相同则不 dispatch，避免自己敲出的变化再回写一次。 */
function replace(view: EditorView | undefined, next: string): void {
	if (!view) return;
	const current = view.state.doc.toString();
	if (current === next) return;
	// 同一文件的另一窗格更新时只替换变化区间，保留其余位置的光标与撤销映射。
	let from = 0;
	while (from < current.length && from < next.length && current[from] === next[from]) from++;
	let to = current.length;
	let end = next.length;
	while (to > from && end > from && current[to - 1] === next[end - 1]) {
		to--;
		end--;
	}
	view.dispatch({ changes: { from, to, insert: next.slice(from, end) }, annotations: externalChange.of(true) });
}

/**
 * 编辑：单个 CodeMirror 6 视图，onChange / onSelection 回传全文与选区。
 * 比较：MergeView 左 original 右 content；给了 onChange 时右侧可编辑，并可按块把左侧回退进来（作者逐块采纳或放弃改动）。
 */
export default function CodeEditor({
	content,
	original,
	path,
	measure = "full",
	autoFocus = true,
	onChange,
	onSelection,
	position,
	onPosition,
	comparison,
}: {
	content: string;
	comparison?: ComparisonConfig;
	autoFocus?: boolean;
	original?: string;
	path: string;
	/** 阅读与编辑共用内容行宽；源码与并排差异利用全部空间。只改排版，不重建编辑器。 */
	measure?: "reading" | "document" | "full";
	onChange?: (value: string) => void;
	onSelection?: (value: string) => void;
	position?: EditorPosition | undefined;
	onPosition?: (value: EditorPosition) => void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const activeSide = useRef<"a" | "b">("b");
	const views = useRef<{ current: EditorView; before?: EditorView; merge?: MergeView } | null>(null);
	const callbacks = useRef({ onChange, onSelection, onPosition, comparison });
	callbacks.current = { onChange, onSelection, onPosition, comparison };
	const [mergeUI, setMergeUI] = useState<MergeView | null>(null);
	const dedicated = !!comparison;
	const unified = comparison?.layout === "unified";
	const ratio = comparison?.ratio ?? 50;
	const unifiedConfig = useRef(new Compartment());
	// 两种 CodeMirror 容器切换时转交编辑状态；不把旧内容 widget 写入草稿。
	const retained = useRef<{
		path: string;
		state: EditorState;
		anchor: number;
		offset: number;
		beforeTop: number;
		focused: boolean;
	} | null>(null);
	useImperativeHandle(comparison?.controller, () => {
		const active = () =>
			activeSide.current === "a" ? (views.current?.before ?? views.current?.current) : views.current?.current;
		const move = (direction: number) => {
			const current = views.current?.current;
			const source = active();
			const diff = source && getChunks(source.state);
			if (!current || !source || !diff?.chunks.length) return;
			const index = selectedChunk(source);
			const head = source.state.selection.main.head;
			const next =
				index >= 0
					? index + direction
					: direction > 0
						? diff.chunks.findIndex((chunk) => (diff.side === "a" ? chunk.fromA : chunk.fromB) >= head)
						: diff.chunks.findLastIndex((chunk) => (diff.side === "a" ? chunk.endA : chunk.endB) <= head);
			const target = next < 0 && direction > 0 ? 0 : (next + diff.chunks.length) % diff.chunks.length;
			const chunk = diff.chunks[target];
			if (!chunk) return;
			activeSide.current = "b";
			current.dispatch({
				selection: { anchor: Math.min(chunk.fromB, current.state.doc.length) },
				effects: EditorView.scrollIntoView(Math.min(chunk.fromB, current.state.doc.length), { y: "center" }),
			});
			const before = views.current?.before;
			before?.dispatch({
				effects: EditorView.scrollIntoView(Math.min(chunk.fromA, before.state.doc.length), { y: "center" }),
			});
			current.focus();
		};
		return {
			next: () => move(1),
			previous: () => move(-1),
			restore: () => {
				const current = views.current?.current;
				const chunk = current && getChunks(current.state)?.chunks[selectedChunk(active())];
				if (!current || !chunk || !callbacks.current.onChange) return;
				const original = views.current?.before?.state.doc ?? getOriginalDoc(current.state);
				let insert = original.sliceString(chunk.fromA, Math.max(chunk.fromA, chunk.toA - 1));
				if (chunk.fromA !== chunk.toA && chunk.toB <= current.state.doc.length) insert += current.state.lineBreak;
				activeSide.current = "b";
				current.dispatch({
					changes: { from: chunk.fromB, to: Math.min(current.state.doc.length, chunk.toB), insert },
					selection: { anchor: chunk.fromB },
					userEvent: "input.revert",
				});
				current.focus();
			},
		};
	}, []);
	const diff = original !== undefined;
	const editable = onChange !== undefined;
	const incoming = useRef({ content, original, position, autoFocus });
	incoming.current = { content, original, position, autoFocus };
	useEffect(() => {
		if (!container.current) return;
		const previous =
			retained.current?.path === path && retained.current.state.doc.toString() === incoming.current.content
				? retained.current
				: null;
		const retain = (view: EditorView, before?: EditorView) => {
			if (!dedicated) return;
			const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top));
			retained.current = {
				path,
				state: view.state,
				anchor: block.from,
				offset: view.scrollDOM.scrollTop - block.top,
				beforeTop: before?.scrollDOM.scrollTop ?? previous?.beforeTop ?? 0,
				focused: view.hasFocus,
			};
		};
		activeSide.current = "b";
		let destroyed = false;
		let scheduled = false;
		const publish = () => {
			if (scheduled || !dedicated) return;
			scheduled = true;
			queueMicrotask(() => {
				scheduled = false;
				if (destroyed) return;
				const current = views.current?.current;
				const chunks = current && getChunks(current.state)?.chunks;
				if (!chunks) return;
				callbacks.current.comparison?.onStatus({
					count: chunks.length,
					active: selectedChunk(activeSide.current === "a" ? views.current?.before : current) + 1,
				});
			});
		};
		const savePosition = (view: EditorView) => {
			const { anchor, head } = view.state.selection.main;
			callbacks.current.onPosition?.({
				anchor,
				head,
				top: view.scrollDOM.scrollTop,
				beforeTop: views.current?.before?.scrollDOM.scrollTop ?? 0,
			});
		};
		const restore = (view: EditorView, before?: EditorView) => {
			const position = previous
				? {
						anchor: previous.state.selection.main.anchor,
						head: previous.state.selection.main.head,
						top: 0,
						beforeTop: previous.beforeTop,
					}
				: incoming.current.position;
			if (position)
				view.dispatch({
					selection: {
						anchor: Math.min(position.anchor, view.state.doc.length),
						head: Math.min(position.head, view.state.doc.length),
					},
					annotations: externalChange.of(true),
				});
			const frame = requestAnimationFrame(() => {
				if (previous) {
					view.requestMeasure({
						read: () => view.lineBlockAt(Math.min(previous.anchor, view.state.doc.length)).top,
						write: (top) => {
							view.scrollDOM.scrollTop = top + previous.offset;
						},
					});
					if (before) before.scrollDOM.scrollTop = previous.beforeTop;
					if (previous.focused) view.focus();
				} else if (position) {
					view.scrollDOM.scrollTop = position.top;
					if (before) before.scrollDOM.scrollTop = position.beforeTop ?? 0;
				}
			});
			let syncing: HTMLElement | null = null;
			let syncFrame = 0;
			const scroll = (event: Event) => {
				const source = event.target as HTMLElement;
				if (before && callbacks.current.comparison?.sync && syncing !== source) {
					// 联动纵向滚动量；两栏宽度不同时换行独立，差异导航会分别定位对应变更块。
					const target = source === view.scrollDOM ? before.scrollDOM : view.scrollDOM;
					if (Math.abs(target.scrollTop - source.scrollTop) > 1) {
						syncing = target;
						target.scrollTop = source.scrollTop;
						cancelAnimationFrame(syncFrame);
						syncFrame = requestAnimationFrame(() => {
							syncing = null;
						});
					}
				}
				savePosition(view);
			};
			view.scrollDOM.addEventListener("scroll", scroll);
			before?.scrollDOM.addEventListener("scroll", scroll);
			return () => {
				cancelAnimationFrame(frame);
				cancelAnimationFrame(syncFrame);
				view.scrollDOM.removeEventListener("scroll", scroll);
				before?.scrollDOM.removeEventListener("scroll", scroll);
			};
		};
		const listener = EditorView.updateListener.of((update) => {
			if (update.selectionSet && !update.transactions.some((transaction) => transaction.annotation(externalChange)))
				activeSide.current = "b";
			if (
				update.docChanged ||
				update.selectionSet ||
				(unified && update.transactions.some((transaction) => transaction.effects.length))
			)
				publish();
			if (update.transactions.some((transaction) => transaction.annotation(externalChange))) return;
			if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
			if (update.selectionSet) savePosition(update.view);
			if (update.selectionSet) {
				const range = update.state.selection.main;
				callbacks.current.onSelection?.(update.state.sliceDoc(range.from, range.to));
			}
		});
		const editing = [
			history(),
			...(previous ? [historyField.init(() => previous.state.field(historyField))] : []),
			keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
			listener,
			EditorState.readOnly.of(!editable),
			EditorView.editable.of(editable),
			EditorView.contentAttributes.of({ "aria-label": editable ? "编辑文件内容" : "源文件内容", tabindex: "0" }),
			...base(path),
		];
		if (diff && !unified) {
			const merge = new MergeView({
				a: {
					doc: incoming.current.original ?? "",
					extensions: [
						...base(path),
						EditorState.readOnly.of(true),
						EditorView.editable.of(false),
						EditorView.contentAttributes.of({ "aria-label": "比较基线内容", tabindex: "0" }),
						EditorView.updateListener.of((update) => {
							if (update.selectionSet) activeSide.current = "a";
							if (update.docChanged || update.selectionSet) publish();
						}),
					],
				},
				b: {
					doc: incoming.current.content,
					extensions: editing,
				},
				parent: container.current,
				highlightChanges: true,
				gutter: true,
				...(editable && !dedicated ? { revertControls: "a-to-b" as const } : {}),
				...(!dedicated || callbacks.current.comparison?.changesOnly
					? { collapseUnchanged: { margin: 3, minSize: 6 } }
					: {}),
			});
			views.current = { current: merge.b, before: merge.a, merge };
			if (dedicated) setMergeUI(merge);
			publish();
			const cleanup = restore(merge.b, merge.a);
			return () => {
				destroyed = true;
				retain(merge.b, merge.a);
				cleanup();
				merge.destroy();
				views.current = null;
			};
		}
		const view = new EditorView({
			state: EditorState.create({
				doc: incoming.current.content,
				extensions: [
					...editing,
					...(unified
						? [
								unifiedConfig.current.of(
									unifiedExtensions(
										incoming.current.original ?? "",
										callbacks.current.comparison?.changesOnly ?? false,
									),
								),
							]
						: []),
				],
			}),
			parent: container.current,
		});
		views.current = { current: view };
		setMergeUI(null);
		publish();
		const cleanup = restore(view);
		if (editable && incoming.current.autoFocus) view.focus();
		return () => {
			destroyed = true;
			retain(view);
			cleanup();
			view.destroy();
			views.current = null;
		};
	}, [path, diff, editable, dedicated, unified]);
	// 外部改了内容（保存后回读、外部修改）时同步进视图；自己敲出的变化已经等于 content，不会重复 dispatch。
	useEffect(() => replace(views.current?.current, content), [content]);
	useEffect(() => {
		const current = views.current?.current;
		if (unified && current) {
			const before = getOriginalDoc(current.state);
			if (before.toString() !== original)
				current.dispatch({
					effects: originalDocChangeEffect(
						current.state,
						ChangeSet.of({ from: 0, to: before.length, insert: original ?? "" }, before.length),
					),
					annotations: externalChange.of(true),
				});
		} else replace(views.current?.before, original ?? "");
	}, [original, unified]);
	const changesOnly = comparison?.changesOnly;
	useEffect(() => {
		const current = views.current?.current;
		if (unified && current)
			current.dispatch({
				effects: unifiedConfig.current.reconfigure(
					unifiedExtensions(getOriginalDoc(current.state).toString(), changesOnly ?? false),
				),
			});
		// 上游用显式 undefined 关闭折叠，声明尚未适配 exactOptionalPropertyTypes。
		else if (dedicated)
			views.current?.merge?.reconfigure({
				collapseUnchanged: changesOnly ? { margin: 3, minSize: 6 } : undefined,
			} as MergeConfig);
	}, [changesOnly, dedicated, unified]);
	const beforeHost = mergeUI?.a.dom.parentElement;
	const afterHost = mergeUI?.b.dom.parentElement;
	const separatorHost = mergeUI?.dom.firstElementChild;
	return (
		<div
			ref={container}
			className="cm-host"
			data-measure={measure}
			data-comparison={dedicated}
			data-layout={unified ? "unified" : "split"}
			style={
				{
					height: "100%",
					minHeight: 0,
					flex: 1,
					"--comparison-first": `${ratio}fr`,
					"--comparison-second": `${100 - ratio}fr`,
				} as CSSProperties
			}
		>
			{comparison && unified && (
				<div className="comparison-heading comparison-unified-heading">
					{comparison.before}
					<span aria-hidden className="text-muted-foreground">
						→
					</span>
					{comparison.after}
				</div>
			)}
			{comparison && !unified && beforeHost && afterHost && separatorHost && (
				<>
					{createPortal(<div className="comparison-heading">{comparison.before}</div>, beforeHost)}
					{createPortal(<div className="comparison-heading">{comparison.after}</div>, afterHost)}
					{createPortal(<ComparisonResizer ratio={ratio} onChange={comparison.onRatio} />, separatorHost)}
				</>
			)}
		</div>
	);
}
