import type { WorkbenchContext } from "@suiming/sdk";
import { documentLocation, documentPaths } from "./document-navigation.js";
import { type Book, pageKind } from "./model.js";
import { activeView } from "./view-state.js";
import { groupView, type WorkspaceLayout } from "./workspace-layout.js";

/** 只提供作品界面信息；host 指令与私有目录不自动进入模型上下文。 */
export function contextPath(path: string): boolean {
	return !!path && !/^(?:\.git|\.suiming|\.agents|\.claude|\.codex|\.grok)(?:\/|$)/iu.test(path);
}
export function captureWorkbenchContext(layout: WorkspaceLayout, book?: Book): WorkbenchContext {
	const state = groupView(layout);
	const view = activeView(state);
	const { kind, isBeat: beat, editPath: path } = documentLocation(view, book);
	const allowed = contextPath(path);
	const document = ["artifact", "file", "diff"].includes(kind);
	const paths = [
		...new Set(
			layout.groups
				.flatMap((g) => g.tabs.flatMap((t) => documentPaths(book, t.location)))
				.filter((p) => contextPath(p) && pageKind(p) === "artifact"),
		),
	];
	return {
		location: JSON.stringify([
			layout.activeGroup,
			state.tabs[state.active]?.id,
			view.page,
			view.beatView,
			view.edit,
			view.diffRevision,
			view.diffExternal,
		]),
		active: {
			page: allowed || !document ? view.page : "private",
			title: allowed
				? book?.title(book.byPath.get(path)) || path
				: document
					? "非作品文件"
					: (book?.pageTitle(view.page) ?? view.page),
			...(allowed ? { path } : {}),
			view: kind === "diff" ? "diff" : view.edit === "edit" ? "edit" : beat ? view.beatView : "read",
			unsaved: allowed && !!layout.documents[path],
			...(allowed && view.selectedText
				? { selection: view.selectedText.slice(0, 4000), selectionTruncated: view.selectedText.length > 4000 }
				: {}),
			...(kind === "diff"
				? {
						comparison: {
							against: view.diffExternal ? ("disk" as const) : ("canon" as const),
							revision: view.diffRevision,
						},
					}
				: {}),
		},
		openDocuments: paths.slice(0, 40).map((path) => ({ path, unsaved: !!layout.documents[path] })),
		openDocumentCount: paths.length,
	};
}
/** 精确定位源码；重复引文须用行号消歧，避免悄悄跳到错误位置。 */
export function locateDocumentText(
	content: string,
	target: { line?: number; quote?: string },
): { from: number; to: number } {
	const lines = content.split("\n");
	if (target.line !== undefined && (!Number.isInteger(target.line) || target.line < 1 || target.line > lines.length))
		throw new Error("行号超出当前文档范围");
	const from = target.line ? lines.slice(0, target.line - 1).reduce((n, s) => n + s.length + 1, 0) : 0;
	if (target.quote) {
		const found = content.indexOf(target.quote, from);
		if (found < 0 || (target.line && found > from + (lines[target.line - 1]?.length ?? 0)))
			throw new Error("当前内容中找不到指定引文，请重新读取文件");
		const next = content.indexOf(target.quote, found + 1);
		if (next >= 0 && (!target.line || next <= from + (lines[target.line - 1]?.length ?? 0)))
			throw new Error("引文在文档中有多处，请补充行号或使用更完整的引文定位");
		return { from: found, to: found + target.quote.length };
	}
	return { from, to: from + (lines[(target.line ?? 1) - 1]?.length ?? 0) };
}
