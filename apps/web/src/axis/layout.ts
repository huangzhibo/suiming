import type { Book, FileEntry, ReviewReport } from "../model.js";

/**
 * 故事轴的数据模型：一切以 index.yaml 的 Beat 顺序为坐标（ordinal），泳道只是同一坐标上的不同投影。
 * 这里全是纯函数，可以在 node:test 里直接验证；渲染在 StoryAxis.tsx。
 */

export interface AxisBeat {
	id: string;
	ordinal: number;
	volumeId: string;
	title: string;
	path: string;
	/** committed = 已提交正文且与 Design 一致；incompatible = 有正文但 Design 已变化；none = 仅设计。 */
	text: "committed" | "incompatible" | "none";
	textPath: string | undefined;
	dirty: boolean;
}

export interface AxisVolume {
	id: string;
	title: string;
	start: number;
	end: number;
}

export interface ContractLane {
	path: string;
	id: string;
	title: string;
	open: number[];
	advance: number[];
	resolve: number[];
	/** resolve 之后仍出现的 advance：Checker 不报，作者要看。 */
	late: number[];
	deadline: string | undefined;
	/** deadline 在轴上的位置；book_end 指向最后一个 Beat；没有或解析不到为 -1。 */
	deadlineIndex: number;
	subjects: string[];
}

export interface AxisReview {
	reportId: string;
	verdict: string;
	current: boolean;
	findings: number;
}

/** 覆盖多个 Beat 的审稿（设计层或整卷）：画成区间线而不是逐列三角，否则一份全书审稿会在每一列都出现。 */
export interface AxisReviewSpan {
	reportId: string;
	verdict: string;
	current: boolean;
	findings: number;
	layer: string;
	start: number;
	end: number;
}

/** refs.beat：晚 Beat（to）依赖早 Beat（from）。 */
export interface Arc {
	from: number;
	to: number;
}

export interface CharacterEvent {
	ordinal: number;
	kind: "dead" | "secret" | "location";
	note: string;
}

export interface CharacterLane {
	path: string;
	id: string;
	title: string;
	/** refs.character 含此人的 Beat（ordinal），表示实质使用，不表示出场或 POV。 */
	present: number[];
	events: CharacterEvent[];
	deadAt: number;
}

export interface WorldLane {
	path: string;
	title: string;
	present: number[];
}

export interface ResourceEvent {
	ordinal: number;
	kind: "holder" | "location" | "consumed" | "destroyed";
	value: string;
}

/** 资源流转：initial.holder 起点，changes.*.holder / location 的每次变化一个节点，consumed / destroyed 终止。 */
export interface ResourceLane {
	path: string;
	title: string;
	initialHolder: string | undefined;
	events: ResourceEvent[];
}

export interface AxisModel {
	beats: AxisBeat[];
	volumes: AxisVolume[];
	contracts: ContractLane[];
	arcs: Arc[];
	/** 按首次出现排序。 */
	characters: CharacterLane[];
	worlds: WorldLane[];
	resources: ResourceLane[];
	/** 当前有效审稿的 finding 数，按锚到的 Beat 归组。 */
	findings: Map<number, number>;
	/** 只锚到单个 Beat 的审稿，按 ordinal 分组。 */
	reviews: Map<number, AxisReview[]>;
	spans: AxisReviewSpan[];
}

export function axisModel(book: Book, reviews: ReviewReport[]): AxisModel {
	const beats: AxisBeat[] = book.order.map((id, ordinal) => {
		const beat = book.beat(id);
		const text = book.text(id);
		const currency = book.currencyOf(id);
		return {
			id,
			ordinal,
			volumeId: book.volumeOf(id)?.id ?? "",
			title: book.beatTitle(id),
			path: beat?.path ?? "",
			text: text ? (currency?.state === "design-changed" ? "incompatible" : "committed") : "none",
			textPath: text?.path,
			dirty: !!(beat?.dirty || text?.dirty),
		};
	});
	const volumes: AxisVolume[] = [];
	for (const beat of beats) {
		const last = volumes.at(-1);
		if (last && last.id === beat.volumeId) last.end = beat.ordinal;
		else
			volumes.push({
				id: beat.volumeId,
				title: book.data.volumes.find((volume) => volume.id === beat.volumeId)?.title ?? "未入卷",
				start: beat.ordinal,
				end: beat.ordinal,
			});
	}
	// 只认 Target 文件：Source 抽取里同名的 beat-0003 不是 Target 第 3 列（按 localId 会把 Source 审稿画成覆盖全书的区间）
	const ordinalOfPath = (path: string) => {
		const file = book.byPath.get(path);
		return file?.namespace === "target" ? book.ordinal(file.localId) : -1;
	};
	const contracts = book.data.files
		.filter((file) => file.kind === "story-contract" && file.namespace === "target")
		.map((file) => contractLane(book, file, ordinalOfPath))
		.filter((lane) => lane.open.length + lane.advance.length + lane.resolve.length > 0)
		.sort((a, b) => (a.open[0] ?? a.advance[0] ?? 0) - (b.open[0] ?? b.advance[0] ?? 0));
	const reviewMap = new Map<number, AxisReview[]>();
	const spans: AxisReviewSpan[] = [];
	for (const report of reviews) {
		const ordinals = [
			...new Set(report.paths.map((path) => ordinalOfPath(path)).filter((ordinal) => ordinal >= 0)),
		].sort((a, b) => a - b);
		if (ordinals.length === 0) continue;
		const summary = {
			reportId: report.id,
			verdict: report.verdict,
			current: report.current,
			findings: report.findings.length,
		};
		if (ordinals.length === 1) {
			const ordinal = ordinals[0] ?? 0;
			reviewMap.set(ordinal, [...(reviewMap.get(ordinal) ?? []), summary]);
		} else {
			spans.push({ ...summary, layer: report.layer, start: ordinals[0] ?? 0, end: ordinals.at(-1) ?? 0 });
		}
	}
	spans.sort((a, b) => a.start - b.start || a.end - b.end);
	const arcs = book.links
		.filter((link) => link.key === "refs.beat")
		.map((link) => ({ from: ordinalOfPath(link.to), to: ordinalOfPath(link.from) }))
		.filter((arc) => arc.from >= 0 && arc.to >= 0 && arc.from !== arc.to)
		.sort((a, b) => a.from - b.from || a.to - b.to);
	const presentOf = (path: string, key: string) =>
		[
			...new Set(
				book.links
					.filter((link) => link.to === path && link.key === key)
					.map((link) => ordinalOfPath(link.from))
					.filter((ordinal) => ordinal >= 0),
			),
		].sort((a, b) => a - b);
	const events = characterEvents(book);
	const characters = book.data.files
		.filter((file) => file.kind === "character" && file.namespace === "target")
		.map((file): CharacterLane => {
			const own = (events.get(file.localId) ?? []).sort((a, b) => a.ordinal - b.ordinal);
			return {
				path: file.path,
				id: file.localId,
				title: book.title(file),
				present: presentOf(file.path, "refs.character"),
				events: own,
				deadAt: own.find((event) => event.kind === "dead")?.ordinal ?? -1,
			};
		})
		.filter((lane) => lane.present.length + lane.events.length > 0)
		.sort((a, b) => (a.present[0] ?? a.events[0]?.ordinal ?? 0) - (b.present[0] ?? b.events[0]?.ordinal ?? 0));
	const worlds = book.data.files
		.filter((file) => file.kind === "world" && file.namespace === "target")
		.map(
			(file): WorldLane => ({
				path: file.path,
				title: book.title(file),
				present: presentOf(file.path, "refs.world"),
			}),
		)
		.filter((lane) => lane.present.length > 0)
		.sort((a, b) => (a.present[0] ?? 0) - (b.present[0] ?? 0));
	const resourceEvents = resourceChanges(book);
	const resources = book.data.files
		.filter((file) => file.kind === "resource" && file.namespace === "target")
		.map((file): ResourceLane => {
			const initial = file.frontmatter.initial as { holder?: unknown } | undefined;
			return {
				path: file.path,
				title: book.title(file),
				initialHolder: typeof initial?.holder === "string" ? initial.holder : undefined,
				events: (resourceEvents.get(file.localId) ?? []).sort((a, b) => a.ordinal - b.ordinal),
			};
		})
		.filter((lane) => lane.initialHolder !== undefined || lane.events.length > 0)
		.sort((a, b) => (a.events[0]?.ordinal ?? -1) - (b.events[0]?.ordinal ?? -1));
	const findings = new Map<number, number>();
	for (const report of reviews) {
		if (!report.current) continue;
		for (const finding of report.findings)
			for (const path of finding.paths) {
				const ordinal = ordinalOfPath(path);
				if (ordinal >= 0) findings.set(ordinal, (findings.get(ordinal) ?? 0) + 1);
			}
	}
	return { beats, volumes, contracts, reviews: reviewMap, spans, arcs, characters, worlds, resources, findings };
}

function resourceChanges(book: Book): Map<string, ResourceEvent[]> {
	const events = new Map<string, ResourceEvent[]>();
	for (const id of book.order) {
		const changes = book.beat(id)?.frontmatter.changes as { world?: Record<string, unknown> } | undefined;
		const ordinal = book.ordinal(id);
		for (const [key, value] of Object.entries(changes?.world ?? {})) {
			const parsed = stateKey(key);
			if (!parsed) continue;
			const { object, prop } = parsed;
			let event: ResourceEvent | undefined;
			if ((prop === "holder" || prop === "location") && typeof value === "string")
				event = { ordinal, kind: prop, value };
			else if ((prop === "consumed" || prop === "destroyed") && value === true)
				event = { ordinal, kind: prop, value: "" };
			if (event) events.set(object, [...(events.get(object) ?? []), event]);
		}
	}
	return events;
}

/**
 * 状态键是扁平的 `<对象>.<属性>`，对象可以带 kind 前缀（`resource:密信.holder`），与裸 id 等价；
 * `revealed` 只属于 Secret，所以 `密信来历.revealed` 与 `secret:密信来历.revealed` 是同一个键（见 Story Language state.md）。
 */
function stateKey(key: string): { object: string; prop: string } | undefined {
	const dot = key.lastIndexOf(".");
	if (dot <= 0) return undefined;
	return { object: key.slice(0, dot).replace(/^(?:character|place|resource|secret):/u, ""), prop: key.slice(dot + 1) };
}

/**
 * 硬状态里与人物有关的变化：`changes.world.<人>.dead / location`，`changes.character.<人>` 下的秘密揭示。只读记录，不推断。
 */
function characterEvents(book: Book): Map<string, CharacterEvent[]> {
	const events = new Map<string, CharacterEvent[]>();
	const add = (who: string, event: CharacterEvent) => events.set(who, [...(events.get(who) ?? []), event]);
	for (const id of book.order) {
		const beat = book.beat(id);
		const changes = beat?.frontmatter.changes as
			| { world?: Record<string, unknown>; character?: Record<string, unknown> }
			| undefined;
		if (!changes) continue;
		const ordinal = book.ordinal(id);
		for (const [key, value] of Object.entries(changes.world ?? {})) {
			const parsed = stateKey(key);
			if (!parsed) continue;
			const { object: who, prop } = parsed;
			if (prop === "dead" && value === true)
				add(who, { ordinal, kind: "dead", note: `死亡记录（changes.world.${key}）` });
			else if (prop === "location" && typeof value === "string")
				add(who, { ordinal, kind: "location", note: `位置改为：${value}` });
		}
		for (const [who, record] of Object.entries(changes.character ?? {})) {
			if (!record || typeof record !== "object") continue;
			for (const key of Object.keys(record)) {
				const parsed = stateKey(key);
				if (parsed?.prop === "revealed") add(who, { ordinal, kind: "secret", note: `秘密揭示：${parsed.object}` });
			}
		}
	}
	return events;
}

function contractLane(book: Book, file: FileEntry, ordinalOfPath: (path: string) => number): ContractLane {
	const anchors = (key: string) =>
		[
			...new Set(
				book.links
					.filter((link) => link.to === file.path && link.key === `contracts.${key}`)
					.map((link) => ordinalOfPath(link.from))
					.filter((ordinal) => ordinal >= 0),
			),
		].sort((a, b) => a - b);
	const open = anchors("open");
	const advance = anchors("advance");
	const resolve = anchors("resolve");
	const resolveAt = resolve[0];
	const deadline = typeof file.frontmatter.deadline === "string" ? file.frontmatter.deadline : undefined;
	const subjects = file.frontmatter.subjects as { character?: unknown } | undefined;
	return {
		path: file.path,
		id: file.localId,
		title: book.title(file),
		open,
		advance,
		resolve,
		late: resolveAt === undefined ? [] : advance.filter((ordinal) => ordinal > resolveAt),
		deadline,
		// 全书未完待续时 book_end 不在任何一列上：最后一个 Beat 不是结局
		deadlineIndex:
			deadline === "book_end"
				? book.data.openEnded
					? -1
					: book.order.length - 1
				: deadline
					? book.ordinal(deadline)
					: -1,
		subjects: Array.isArray(subjects?.character)
			? subjects.character.filter((x): x is string => typeof x === "string")
			: [],
	};
}

/** 可见范围：进入某一卷只画那一卷；null 或找不到的卷画全书。 */
export function visibleRange(model: AxisModel, volumeId: string | null): { start: number; end: number } {
	if (model.beats.length === 0) return { start: 0, end: -1 };
	const volume = volumeId === null ? undefined : model.volumes.find((volume) => volume.id === volumeId);
	return volume ? { start: volume.start, end: volume.end } : { start: 0, end: model.beats.length - 1 };
}

/** 承诺在某个时点的状态文字，与上下文栏一致；给了 beatTitle 就点名 Beat，作者不认序号。 */
export function contractStatus(
	lane: ContractLane,
	cursorIndex: number,
	beatTitle: (ordinal: number) => string = (ordinal) => `第 ${ordinal + 1} 个情节`,
): string {
	const opened = lane.open.length > 0 && (lane.open[0] ?? 0) <= cursorIndex;
	const resolved = lane.resolve.length > 0 && (lane.resolve[0] ?? 0) <= cursorIndex;
	if (!opened) return "尚未建立";
	if (resolved) return `已回应 · ${beatTitle(lane.resolve[0] ?? 0)}`;
	if (lane.deadlineIndex >= 0 && cursorIndex >= lane.deadlineIndex) return "已到期限，尚未回应";
	return "等待回应";
}
