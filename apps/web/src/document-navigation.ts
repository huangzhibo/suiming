import { type Book, filePage, pageKind, pageTarget, textPathFor } from "./model.js";
import {
	activeView,
	navigate,
	type OpenOptions,
	openingPage,
	type PageState,
	patchView,
	type ViewState,
	type WorkbenchState,
} from "./view-state.js";

/** 文件树描述物理位置；已识别的文件仍打开同一作品页，并明确设计 / 正文。 */
export function documentTarget(book: Book | undefined, requested: string) {
	const fromFile = pageKind(requested) === "file";
	const path = fromFile ? pageTarget(requested) : requested;
	const file = book?.byPath.get(path);
	const beat = file?.kind === "story-text" && file.namespace === "target" ? book?.beat(file.localId) : undefined;
	const object = beat ?? file;
	const isBeat = object?.kind === "story-beat" && object.namespace === "target";
	return {
		// 对象页面渲染 Markdown 文档；索引与配置仍以文件展示，保留 YAML 缩进。
		page: beat?.path ?? (file ? (path.endsWith(".md") ? path : filePage(path)) : requested),
		path,
		isBeat,
		beatView: beat ? ("text" as const) : fromFile && isBeat ? ("design" as const) : undefined,
		textPath: isBeat ? textPathFor(object.localId) : "",
	};
}

export function openDocument(
	state: WorkbenchState,
	book: Book | undefined,
	requested: string,
	extra: Partial<ViewState> = {},
	options: OpenOptions = {},
	protectedTab = false,
): WorkbenchState {
	const target = documentTarget(book, requested);
	const selection = { ...(target.beatView ? { beatView: target.beatView } : {}), ...extra };
	const initial = openingPage(target.page, state.beatPreference, target.isBeat, selection);
	const next = {
		...initial,
		...Object.fromEntries(Object.entries(selection).filter(([key]) => key in initial)),
	};
	const moved = navigate(state, next, options, protectedTab);
	if (options.background || !Object.keys(selection).length) return moved;
	// 激活已有编辑页时同步编辑目标；草稿和光标仍按物理路径保存。
	return patchView(moved, {
		...selection,
		...(target.isBeat && selection.beatView && selection.targetPath === undefined
			? {
					targetPath:
						(selection.edit ?? activeView(moved).edit) === "edit"
							? selection.beatView === "text"
								? target.textPath
								: target.page
							: "",
				}
			: {}),
	});
}

/** 恢复旧文件入口时只统一页面身份，保留标签、历史、编辑位置与共享草稿。 */
export function resolveDocumentPage(book: Book, location: PageState): PageState {
	const target = documentTarget(book, location.page);
	if (target.page === location.page) return location;
	return {
		...location,
		page: target.page,
		...(target.beatView ? { beatView: target.beatView, resolveContent: false } : {}),
		targetPath: location.edit === "edit" ? target.path : "",
	};
}
