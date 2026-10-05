import type { ReadingSelection } from "./view-state.js";
/** 使用正文内文字偏移，跨 Markdown 的强调等节点保存选区。 */
export function captureReadingSelection(body: HTMLElement, selection: Selection): ReadingSelection | null {
	const anchor = selection.anchorNode;
	const focus = selection.focusNode;
	if (!anchor || !focus) return null;
	const scopes = [...body.querySelectorAll<HTMLElement>("[data-prose]")];
	const scope = scopes.findIndex((element) => element.contains(anchor) && element.contains(focus));
	const element = scopes[scope];
	if (!element) return null;
	const offset = (node: Node, offset: number) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		range.setEnd(node, offset);
		return range.toString().length;
	};
	return { scope, anchor: offset(anchor, selection.anchorOffset), focus: offset(focus, selection.focusOffset) };
}
export function restoreReadingSelection(body: HTMLElement, saved: ReadingSelection): void {
	const scope = body.querySelectorAll<HTMLElement>("[data-prose]")[saved.scope];
	if (!scope) return;
	const point = (offset: number): [Node, number] | null => {
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const length = node.textContent?.length ?? 0;
			if (offset <= length) return [node, offset];
			offset -= length;
		}
		return null;
	};
	const anchor = point(saved.anchor);
	const focus = point(saved.focus);
	if (anchor && focus) window.getSelection()?.setBaseAndExtent(...anchor, ...focus);
}
