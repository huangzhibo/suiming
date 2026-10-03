import type { ComposerState } from "./composer-state.js";
import { PANE_WIDTH } from "./pane-layout.js";

export interface ReadingSelection {
	scope: number;
	anchor: number;
	focus: number;
}
export type SideMode = "spine" | "files" | "ids" | "sources" | "search";
export type RightMode = "back" | "evidence" | "agent" | "state";
/** 明确发起的状态查询，打开来源文件不改变它。只是可恢复的客户端查询条件。 */
export interface ObservationSelection {
	storyBeatId: string;
	phase: "before" | "changes" | "after";
	subject?: { kind: "character" | "resource" | "contract"; id: string };
}
/** 同一 Beat 下的两份内容；分屏是工作区布局，不是第三种内容。 */
export type BeatView = "design" | "text";
export type ComparisonLayout = "unified" | "split";
export function resolveComparisonLayout(preference: ComparisonLayout | null, width: number): ComparisonLayout {
	return preference ?? (width < 760 ? "unified" : "split");
}
export type EditMode = "read" | "edit";

/** 可恢复的客户端 view state：路由、选择、展开与面板，不是作品或运行真源。 */
export interface WorkbenchState extends ComposerState {
	tabs: WorkbenchTab[];
	active: number;
	beatPreference: BeatView;
	documents: Record<string, DocumentDraft>;
	recentPages: string[];
	sidePositions: Partial<Record<SideMode, Record<string, number>>>;
	fileFolders: Record<string, boolean>;
	fileSelection: string;
	searchQuery: string;
	idsByCount: boolean;
	side: SideMode;
	sideOpen: boolean;
	/** 作者设置的侧栏宽度；窗口临时收窄不覆盖这两个偏好。 */
	leftWidth: number;
	rightWidth: number;
	right: boolean;
	rightMode: RightMode;
	expanded: boolean;
	/** 故事轴选中的 Beat，只定位与突出相关关系。 */
	axisSelected: string;
	observation: ObservationSelection | null;
	openVols: Record<string, boolean>;
	openGroups: Record<string, boolean>;
	showIds: boolean;
	conversationPositions: Record<string, { top: number; follow: boolean }>;
	/** 故事轴标题列宽度（px），拖右边缘调整。 */
	axisLabelWidth: number;
	/** 故事轴展开的泳道组：全部人物、世界文档。 */
	axisAllCharacters: boolean;
	axisWorlds: boolean;
	axisResources: boolean;
	/** finding 密度：把当前有效审稿的 finding 数画在覆盖泳道底色上。 */
	axisFindings: boolean;
	/** 故事轴上刷选的区间（Beat id，含两端）；上下文栏的身份计数改为区间内计数。 */
	axisRange: { start: string; end: string } | null;
}
export const DEFAULT_VIEW: WorkbenchState = {
	tabs: [],
	active: 0,
	beatPreference: "design",
	documents: {},
	recentPages: [],
	sidePositions: {},
	fileFolders: {},
	fileSelection: "",
	searchQuery: "",
	idsByCount: false,
	// 初次打开以作品大纲为导航；已有工作现场仍按作品恢复。
	side: "spine",
	sideOpen: true,
	leftWidth: PANE_WIDTH.left.default,
	rightWidth: PANE_WIDTH.right.default,
	right: true,
	rightMode: "agent",
	expanded: false,
	axisSelected: "",
	observation: null,
	openVols: {},
	openGroups: { character: true, "story-contract": true },
	showIds: false,
	sessionId: "",
	sessionChosen: false,
	composerDrafts: {},
	conversationPositions: {},
	axisLabelWidth: 184,
	axisAllCharacters: false,
	axisWorlds: false,
	axisResources: false,
	axisFindings: false,
	axisRange: null,
};
/** 页面快照保留表示和位置；历史访问不复制文件缓冲。 */
export interface EditorPosition {
	anchor: number;
	head: number;
	top: number;
	beforeTop?: number;
}
export interface PageState {
	page: string;
	beatView: BeatView;
	/** 中性导航待实际正文读取后确定一次；历史恢复不重新判断。 */
	resolveContent: boolean;
	edit: EditMode;
	targetPath: string;
	diffRevision: string | null;
	diffExternal: boolean;
	/** 比较是独立标签，关闭时回到发起它的标签。 */
	diffOrigin: string | null;
	diffLayout: ComparisonLayout | null;
	diffRatio: number;
	diffSync: boolean;
	diffChangesOnly: boolean;
	scrolls: Record<string, { top: number; left: number }>;
	editors: Record<string, EditorPosition>;
	selectedText: string;
	proseSelection: ReadingSelection | null;
	selPara: number;
	axisVolume: string | null;
	axisColumn: number | null;
	review: { anchor: string; active: number };
	versionFile: string;
}
export interface WorkbenchTab {
	id: string;
	pinned: boolean;
	location: PageState;
	back: PageState[];
	forward: PageState[];
}
/** 同一 checkout 文件的所有视图共享未保存内容及 CAS 基线。 */
export interface DocumentDraft {
	content: string;
	baseContent: string;
	baseSHA: string | null;
}
/** 组件消费的投影；页面字段只在 tab.location 中持久化。 */
export type ViewState = WorkbenchState & PageState;
export const EMPTY_PAGE = "empty:";
export function pageState(page = EMPTY_PAGE): PageState {
	return {
		page,
		beatView: "design",
		resolveContent: false,
		edit: "read",
		targetPath: "",
		diffRevision: null,
		diffExternal: false,
		diffOrigin: null,
		diffLayout: null,
		diffRatio: 50,
		diffSync: true,
		diffChangesOnly: false,
		scrolls: {},
		editors: {},
		selectedText: "",
		proseSelection: null,
		selPara: -1,
		axisVolume: null,
		axisColumn: null,
		review: { anchor: "", active: -1 },
		versionFile: "",
	};
}
export function createTab(location = pageState()): WorkbenchTab {
	return { id: crypto.randomUUID(), pinned: false, location, back: [], forward: [] };
}
const pageKeys = new Set(Object.keys(pageState()));
export function activeView(state: WorkbenchState): ViewState {
	return { ...state, ...(state.tabs[state.active]?.location ?? pageState()) };
}
export function patchView(state: WorkbenchState, partial: Partial<ViewState>): WorkbenchState {
	const pagePatch = Object.fromEntries(Object.entries(partial).filter(([key]) => pageKeys.has(key)));
	const globalPatch = Object.fromEntries(Object.entries(partial).filter(([key]) => !pageKeys.has(key)));
	return {
		...state,
		...globalPatch,
		...(partial.beatView ? { beatPreference: partial.beatView } : {}),
		...(partial.sessionId !== undefined ? { sessionChosen: true } : {}),
		tabs: Object.keys(pagePatch).length
			? state.tabs.map((tab, index) =>
					index === state.active
						? {
								...tab,
								location: {
									...tab.location,
									...(partial.beatView ? { resolveContent: false } : {}),
									...pagePatch,
								},
							}
						: tab,
				)
			: (partial.tabs ?? state.tabs),
	};
}
export interface OpenOptions {
	newTab?: boolean;
	background?: boolean;
}
export type OpenPage = (page: string, extra?: Partial<ViewState>, options?: OpenOptions) => void;
/** 目录、链接和搜索共用打开策略；显式新开优先于去重。 */
export function navigate(
	state: WorkbenchState,
	next: PageState,
	options: OpenOptions = {},
	protectedTab = false,
): WorkbenchState {
	const recentPages = [next.page, ...state.recentPages.filter((page) => page !== next.page)]
		.filter((page) => page !== EMPTY_PAGE && !page.startsWith("diff:"))
		.slice(0, 30);
	const existing = state.tabs.findIndex((tab) => tab.location.page === next.page);
	if (!options.newTab && existing >= 0) return { ...state, active: existing, recentPages };
	const current = state.tabs[state.active];
	if (options.newTab || !current || current.pinned || current.location.page.startsWith("diff:") || protectedTab) {
		const insertion = current ? state.active + 1 : 0;
		const tabs = [...state.tabs];
		tabs.splice(insertion, 0, createTab(next));
		return { ...state, tabs, active: options.background && current ? state.active : insertion, recentPages };
	}
	return {
		...state,
		recentPages,
		tabs: state.tabs.map((tab, index) =>
			index !== state.active
				? tab
				: {
						...tab,
						location: next,
						forward: [],
						back: [...tab.back, tab.location].filter((location) => location.page !== EMPTY_PAGE).slice(-50),
					},
		),
	};
}
export function historyMove(
	state: WorkbenchState,
	direction: "back" | "forward",
	protectedTab: boolean,
): WorkbenchState {
	const tab = state.tabs[state.active];
	const target = tab?.[direction].at(-1);
	if (!tab || !target) return state;
	if (protectedTab) return navigate(state, target, {}, true);
	return {
		...state,
		tabs: state.tabs.map((item, index) =>
			index !== state.active
				? item
				: {
						...item,
						location: target,
						back: direction === "back" ? item.back.slice(0, -1) : [...item.back, item.location],
						forward: direction === "forward" ? item.forward.slice(0, -1) : [...item.forward, item.location],
					},
		),
	};
}
export function removeTab(state: WorkbenchState, id: string): WorkbenchState {
	const index = state.tabs.findIndex((tab) => tab.id === id);
	if (index < 0) return state;
	const tabs = state.tabs.filter((tab) => tab.id !== id);
	return {
		...state,
		tabs: tabs.length ? tabs : [createTab()],
		active: Math.max(0, Math.min(state.active > index ? state.active - 1 : state.active, tabs.length - 1)),
	};
}
export function editDocument(
	state: WorkbenchState,
	path: string,
	content: string,
	base: { content: string; sha256: string | null },
): WorkbenchState {
	const old = state.documents[path];
	const draft = { content, baseContent: old?.baseContent ?? base.content, baseSHA: old ? old.baseSHA : base.sha256 };
	const documents = { ...state.documents };
	if (content === draft.baseContent) delete documents[path];
	else documents[path] = draft;
	return { ...state, documents };
}
/** 保存时仍可切换页面、继续输入；只清除这次写入对应的缓冲。 */
export function savedDocument(
	state: WorkbenchState,
	path: string,
	content: string,
	sha256: string | null,
): WorkbenchState {
	const documents = { ...state.documents };
	const draft = documents[path];
	if (!draft || draft.content === content) delete documents[path];
	else documents[path] = { ...draft, baseContent: content, baseSHA: sha256 };
	return { ...state, documents };
}
/** 新访问沿用窗格意图；显式内容请求不受空正文回退影响。 */
export function openingPage(
	page: string,
	preference: BeatView,
	isBeat: boolean,
	extra: Partial<PageState> = {},
): PageState {
	return {
		...pageState(page),
		...(isBeat ? { beatView: preference, resolveContent: preference === "text" && !extra.beatView } : {}),
		...extra,
	};
}
export function resolveOpening(state: WorkbenchState, tabId: string, hasText: boolean): WorkbenchState {
	return {
		...state,
		tabs: state.tabs.map((tab) =>
			tab.id !== tabId || !tab.location.resolveContent
				? tab
				: {
						...tab,
						location: {
							...tab.location,
							resolveContent: false,
							beatView: hasText ? "text" : "design",
							targetPath: "",
						},
					},
		),
	};
}
