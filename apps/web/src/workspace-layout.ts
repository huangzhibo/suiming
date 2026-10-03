import { restoreComposerDrafts } from "./composer-state.js";
import { documentTarget, resolveDocumentPage } from "./document-navigation.js";
import { type Book, diffPage } from "./model.js";
import {
	type BeatView,
	createTab,
	DEFAULT_VIEW,
	navigate,
	type PageState,
	pageState,
	removeTab,
	type WorkbenchState,
	type WorkbenchTab,
} from "./view-state.js";

/** 同一文件与基线只开一份比较；比较页与来源页共享 documents，不复制草稿。 */
export function openComparison(
	layout: WorkspaceLayout,
	groupId: string,
	path: string,
	revision: string | null,
	external = false,
): WorkspaceLayout {
	const page = diffPage(path);
	for (const group of layout.groups) {
		const active = group.tabs.findIndex(
			({ location }) =>
				location.page === page && location.diffRevision === revision && location.diffExternal === external,
		);
		if (active >= 0)
			return {
				...layout,
				activeGroup: group.id,
				groups: layout.groups.map((item) => (item.id === group.id ? { ...item, active } : item)),
			};
	}
	return {
		...updateGroup(layout, groupId, (state) =>
			navigate(
				state,
				{
					...pageState(page),
					targetPath: path,
					diffRevision: revision,
					diffExternal: external,
					diffOrigin: state.tabs[state.active]?.id ?? null,
				},
				{ newTab: true },
			),
		),
		activeGroup: groupId,
	};
}

/** 关闭活跃的比较标签优先回到来源；关闭后台标签不抢焦点。 */
export function closeWorkspaceTab(layout: WorkspaceLayout, groupId: string, id: string): WorkspaceLayout {
	const group = layout.groups.find((item) => item.id === groupId);
	if (!group) return layout;
	const origin =
		layout.activeGroup === groupId && group.tabs[group.active]?.id === id
			? group.tabs[group.active]?.location.diffOrigin
			: null;
	let next =
		group.tabs.length === 1 && layout.groups.length > 1
			? mergeGroup(
					updateGroup(layout, groupId, (state) => ({ ...state, tabs: [] })),
					groupId,
				)
			: updateGroup(layout, groupId, (state) => removeTab(state, id));
	if (origin) {
		for (const item of next.groups) {
			const active = item.tabs.findIndex((tab) => tab.id === origin);
			if (active >= 0) {
				next = {
					...next,
					activeGroup: item.id,
					groups: next.groups.map((group) => (group.id === item.id ? { ...group, active } : group)),
				};
				break;
			}
		}
	}
	return next;
}

export interface TabGroup {
	id: string;
	tabs: WorkbenchTab[];
	active: number;
	beatPreference: BeatView;
}
export type PaneTree =
	| { group: string }
	| {
			id: string;
			orientation: "horizontal" | "vertical";
			sizes: number[];
			first: PaneTree;
			second: PaneTree;
	  };
export type WorkspaceLayout = Omit<WorkbenchState, "tabs" | "active" | "beatPreference"> & {
	groups: TabGroup[];
	activeGroup: string;
	panes: PaneTree;
};

export function workspaceLayout(state: WorkbenchState = DEFAULT_VIEW): WorkspaceLayout {
	const { tabs, active, beatPreference, ...shared } = state;
	const id = crypto.randomUUID();
	return { ...shared, groups: [{ id, tabs, active, beatPreference }], activeGroup: id, panes: { group: id } };
}
export function groupView(layout: WorkspaceLayout, id = layout.activeGroup): WorkbenchState {
	const { groups, activeGroup: _, panes: __, ...shared } = layout;
	const group = groups.find((group) => group.id === id) ?? groups[0];
	if (!group) throw new Error("工作区缺少文档窗格");
	return { ...shared, tabs: group.tabs, active: group.active, beatPreference: group.beatPreference };
}
/** 只写当前窗格的页面状态；文件草稿、侧栏及 Agent 输入始终共享。 */
export function updateGroup(
	layout: WorkspaceLayout,
	id: string,
	update: (state: WorkbenchState) => WorkbenchState,
): WorkspaceLayout {
	if (!layout.groups.some((group) => group.id === id)) return layout;
	const { tabs, active, beatPreference, ...shared } = update(groupView(layout, id));
	return {
		...layout,
		...shared,
		groups: layout.groups.map((group) => (group.id === id ? { ...group, tabs, active, beatPreference } : group)),
	};
}
export function splitGroup(
	layout: WorkspaceLayout,
	id: string,
	orientation: "horizontal" | "vertical",
	location?: PageState,
): WorkspaceLayout {
	const group = layout.groups.find((group) => group.id === id);
	if (!group) return layout;
	const current = location ?? group.tabs[group.active]?.location;
	const newId = crypto.randomUUID();
	const add = (tree: PaneTree): PaneTree =>
		"group" in tree
			? tree.group === id
				? { id: crypto.randomUUID(), orientation, sizes: [50, 50], first: tree, second: { group: newId } }
				: tree
			: { ...tree, first: add(tree.first), second: add(tree.second) };
	return {
		...layout,
		panes: add(layout.panes),
		activeGroup: newId,
		groups: [
			...layout.groups,
			{
				id: newId,
				tabs: [createTab(current)],
				active: 0,
				beatPreference: location?.beatView ?? group.beatPreference,
			},
		],
	};
}
/** 收起窗格时把其标签移到相邻组，草稿与浏览位置均保留。 */
export function mergeGroup(layout: WorkspaceLayout, id: string): WorkspaceLayout {
	if (layout.groups.length < 2) return layout;
	let neighbor = "";
	const firstGroup = (tree: PaneTree): string => ("group" in tree ? tree.group : firstGroup(tree.first));
	const remove = (tree: PaneTree): PaneTree => {
		if ("group" in tree) return tree;
		if ("group" in tree.first && tree.first.group === id) {
			neighbor = firstGroup(tree.second);
			return tree.second;
		}
		if ("group" in tree.second && tree.second.group === id) {
			neighbor = firstGroup(tree.first);
			return tree.first;
		}
		return { ...tree, first: remove(tree.first), second: remove(tree.second) };
	};
	const panes = remove(layout.panes);
	const closing = layout.groups.find((group) => group.id === id);
	if (!neighbor || !closing) return layout;
	return {
		...layout,
		panes,
		activeGroup: neighbor,
		groups: layout.groups
			.filter((group) => group.id !== id)
			.map((group) =>
				group.id === neighbor
					? {
							...group,
							active:
								layout.activeGroup === id && closing.tabs.length
									? group.tabs.length + closing.active
									: group.active,
							tabs: [...group.tabs, ...closing.tabs],
						}
					: group,
			),
	};
}
export function resizePanes(tree: PaneTree, id: string, sizes: number[]): PaneTree {
	if ("group" in tree) return tree;
	if (tree.id === id) return { ...tree, sizes };
	return { ...tree, first: resizePanes(tree.first, id, sizes), second: resizePanes(tree.second, id, sizes) };
}
const storageKey = (project: string) => `suiming.${project}.view`;
export function resolveWorkspaceDocuments(layout: WorkspaceLayout, book: Book): WorkspaceLayout {
	let changed = false;
	const resolve = (location: PageState) => {
		const next = resolveDocumentPage(book, location);
		if (next !== location) changed = true;
		return next;
	};
	const groups = layout.groups.map((group) => ({
		...group,
		tabs: group.tabs.map((tab) => ({
			...tab,
			location: resolve(tab.location),
			back: tab.back.map(resolve),
			forward: tab.forward.map(resolve),
		})),
	}));
	const recentPages = [...new Set(layout.recentPages.map((page) => documentTarget(book, page).page))];
	if (
		recentPages.length !== layout.recentPages.length ||
		recentPages.some((page, i) => page !== layout.recentPages[i])
	)
		changed = true;
	return changed ? { ...layout, groups, recentPages } : layout;
}

/** 页面旧表示只在恢复时迁移，不进入日常导航分支。 */
export function normalizePage(value: PageState): PageState {
	const defaults = pageState();
	return {
		...defaults,
		...Object.fromEntries(Object.entries(value).filter(([key]) => key in defaults)),
		scrolls: Object.fromEntries(
			Object.entries(value.scrolls ?? {}).map(([key, position]) => [
				key.replace(/^(body:(?:design|text)):(?:source|preview)$/, "$1"),
				position,
			]),
		),
		beatView: value.beatView === "text" ? "text" : "design",
		edit: value.edit === "edit" ? "edit" : "read",
		diffLayout: value.diffLayout === "unified" || value.diffLayout === "split" ? value.diffLayout : null,
	};
}
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const activeIndex = (value: unknown, length: number) =>
	Math.max(0, Math.min(typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0, length - 1));
function restorePages(value: unknown): PageState[] {
	return Array.isArray(value)
		? value.flatMap((item) => (typeof record(item).page === "string" ? [normalizePage(item)] : []))
		: [];
}
function restoreTabs(value: unknown, legacy: Record<string, unknown>): WorkbenchTab[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		if (typeof item === "string") {
			const tab = createTab({
				...pageState(item.startsWith("graph:") ? item.slice(6) : item),
				beatView: legacy.beatView === "design" ? "design" : "text",
			});
			const back = record(
				Array.isArray(legacy.history) ? legacy.history[index] : record(legacy.history)[index],
			).back;
			tab.back = Array.isArray(back) ? back.filter((p): p is string => typeof p === "string").map(pageState) : [];
			return [tab];
		}
		const tab = record(item);
		if (typeof record(tab.location).page !== "string") return [];
		return [
			{
				id: typeof tab.id === "string" ? tab.id : crypto.randomUUID(),
				pinned: tab.pinned === true,
				location: normalizePage(tab.location as PageState),
				back: restorePages(tab.back),
				forward: restorePages(tab.forward),
			},
		];
	});
}
/** 存储只读一次；失效的分屏布局不能连带丢掉可恢复的标签、文件草稿与未确认提交。 */
export function restoreWorkspace(value: unknown): WorkspaceLayout {
	const parsed = record(value);
	const state: WorkbenchState = {
		...DEFAULT_VIEW,
		...Object.fromEntries(
			Object.entries(parsed).filter(([key, value]) => {
				if (!(key in DEFAULT_VIEW)) return false;
				const initial = DEFAULT_VIEW[key as keyof WorkbenchState];
				if (initial === null) return value === null || typeof value === "object";
				if (Array.isArray(initial)) return Array.isArray(value);
				if (typeof initial === "object")
					return value !== null && typeof value === "object" && !Array.isArray(value);
				return typeof value === typeof initial && (typeof value !== "number" || Number.isFinite(value));
			}),
		),
		tabs: restoreTabs(parsed.tabs, parsed),
		composerDrafts: restoreComposerDrafts(parsed.composerDrafts),
	};
	state.active = activeIndex(state.active, state.tabs.length);
	state.beatPreference = state.beatPreference === "text" ? "text" : "design";
	const base = workspaceLayout(state);
	const groups: TabGroup[] = Array.isArray(parsed.groups)
		? parsed.groups.flatMap((item) => {
				const group = record(item);
				if (typeof group.id !== "string") return [];
				const tabs = restoreTabs(group.tabs, parsed);
				return [
					{
						id: group.id,
						tabs,
						active: activeIndex(group.active, tabs.length),
						beatPreference: group.beatPreference === "text" ? "text" : "design",
					},
				];
			})
		: [];
	const firstGroup = groups[0];
	if (!firstGroup) return base;
	const leaves: string[] = [];
	const restoreTree = (value: unknown): PaneTree | null => {
		const tree = record(value);
		if (typeof tree.group === "string") {
			leaves.push(tree.group);
			return { group: tree.group };
		}
		if (typeof tree.id !== "string" || !["horizontal", "vertical"].includes(String(tree.orientation))) return null;
		const first = restoreTree(tree.first),
			second = restoreTree(tree.second);
		if (!first || !second) return null;
		const sizes =
			Array.isArray(tree.sizes) &&
			tree.sizes.length === 2 &&
			tree.sizes.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
				? (tree.sizes as number[])
				: [50, 50];
		return { id: tree.id, orientation: tree.orientation as "horizontal" | "vertical", sizes, first, second };
	};
	const panes = restoreTree(parsed.panes);
	if (
		panes &&
		leaves.length === groups.length &&
		new Set(leaves).size === groups.length &&
		new Set(groups.map((group) => group.id)).size === groups.length &&
		groups.every((g) => leaves.includes(g.id))
	)
		return {
			...base,
			groups,
			panes,
			activeGroup: groups.find((g) => g.id === parsed.activeGroup)?.id ?? firstGroup.id,
		};
	const selected = groups.find((g) => g.id === parsed.activeGroup) ?? firstGroup;
	const tabs = groups.flatMap((g) => g.tabs);
	const offset = groups.slice(0, groups.indexOf(selected)).reduce((n, g) => n + g.tabs.length, 0);
	return workspaceLayout({
		...state,
		tabs,
		active: activeIndex(offset + selected.active, tabs.length),
		beatPreference: selected.beatPreference,
	});
}
export function loadWorkspace(project: string): WorkspaceLayout {
	try {
		return restoreWorkspace(JSON.parse(localStorage.getItem(storageKey(project)) ?? "null"));
	} catch {
		// 无法解析的界面偏好不阻止打开作品。
		return workspaceLayout();
	}
}
export function saveWorkspace(project: string, layout: WorkspaceLayout): void {
	localStorage.setItem(storageKey(project), JSON.stringify(layout));
}

type QueryStatus = "pending" | "error" | "success";
/**
 * 工作台整体显示哪一屏。加载态与空态曾经是同一个分支：`workspace.show` 还没返回时渲染欢迎页，作者重载或
 * 切换作品的那一瞬看到「打开作品 / 开始新作」，像是作品没了。作品读不出来（show 报错）时退回文件浏览，
 * 那也要等文件列表回来；两条都失败才是真的没有作品。查询全局不重试，没有作品时两条都会立刻失败。
 */
export function workspaceScreen(state: { show: QueryStatus; files: QueryStatus }): "loading" | "welcome" | "workspace" {
	if (state.show === "success") return "workspace";
	if (state.show === "pending" || state.files === "pending") return "loading";
	return state.files === "success" ? "workspace" : "welcome";
}
