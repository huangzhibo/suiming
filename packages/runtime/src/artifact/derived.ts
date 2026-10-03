import { createHash } from "node:crypto";
import {
	type BoundDesign,
	CANDIDATE_REVISION,
	type CreativeIntent,
	parseReviewFile,
	parseSourceNote,
	parseYaml,
	type ReviewFile,
	type StoryBeat,
	TARGET_DESIGN_KINDS,
} from "@suiming/story";
import { codePointCount } from "./code-points.js";
import { ArtifactError } from "./errors.js";
import { isSourceArtifactIdentity, isTargetArtifactIdentity } from "./identity.js";
import { sourceMaterialFromCandidate } from "./source-material.js";
import { inspectStoryDesignCandidate, validateCompleteStoryTextCandidate } from "./story-design-validator.js";
import type { ArtifactCandidate, ProjectRevision } from "./types.js";

/**
 * 从版本历史派生的状态（[派生状态设计](../../../../docs/derived-evidence-design.md) 3.2）。
 * 这些函数只读 Canon 历史与当前候选，不落盘；Local（git）与 Cloud（PostgreSQL）实现同一个读取面。
 */
export interface RevisionHistoryReader {
	/** 从创世到 head 的祖先链，最老的在前。 */
	history(): Promise<ProjectRevision[]>;
	/** 某个版本下每个作品文件的内容摘要；只要求同一实现内可比较。 */
	fileDigests(revisionId: string): Promise<ReadonlyMap<string, string>>;
	snapshot(revisionId: string): Promise<ArtifactCandidate>;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const DESIGN_KINDS = new Set<string>(TARGET_DESIGN_KINDS);

/** 每个在 head 里存在的路径最后一次变化所在的 revision。 */
export async function writtenAtMap(reader: RevisionHistoryReader, head: string): Promise<Map<string, string>> {
	const history = await reader.history();
	const index = history.findIndex((revision) => revision.id === head);
	if (index === -1) throw new ArtifactError("revision_not_found", `Revision not found: ${head}`);
	const written = new Map<string, string>();
	let previous: ReadonlyMap<string, string> = new Map();
	for (const revision of history.slice(0, index + 1)) {
		const digests = await reader.fileDigests(revision.id);
		for (const [path, digest] of digests) if (previous.get(path) !== digest) written.set(path, revision.id);
		for (const path of previous.keys()) if (!digests.has(path)) written.delete(path);
		previous = digests;
	}
	return written;
}

/**
 * 一个 Beat 的 Design 闭包，即「Design 变了会不会影响这份正文」的边界：取 Writer 写它时读到的那部分 Design，
 * 与 Write Context 同一套选择——这个 Beat、它 refs 的人物 / 地点 / 资源 / World 文档、它 open / advance / resolve 的
 * Contract、覆盖它的 Intent，再加 world/core 与 story index（index 只按这个 Beat 的那一段比，见 `indexEntry`）。
 * 同卷别的 Beat、没碰到的 Contract 与 Intent 不在里面：原先借用 Design Frame，Frame 载入整卷 Beat 与全部 Contract、
 * Intent，同卷任何一节一改，整卷正文都被标成 design-changed，长篇里信号就淹没了（2026-10-04 改）。
 * 别的 Beat 的 `changes` 会改变这节进入时的硬状态，这里按文件比、不算进来；人物已死仍被引用这类由 Checker 报。
 * Design 绑不上、或这个 Beat 已经不在 Design 里时退回整个 Design。
 */
export function designClosurePaths(candidate: ArtifactCandidate, storyBeatId: string): string[] {
	const design = boundDesignOf(candidate);
	if (design === undefined) return designPaths(candidate).sort();
	const beat = design.story.beats.find((item) => item.id === storyBeatId);
	if (beat === undefined) return designPaths(candidate).sort();
	const refs = new Set([...beat.refs, ...beat.stateRefs]);
	const touched = new Set([...beat.contracts.open, ...beat.contracts.advance, ...beat.contracts.resolve]);
	const ordinals = new Map(design.story.beats.map((item) => [item.id, item.ordinal]));
	const paths = new Set<string>([beat.path]);
	for (const entry of design.characters) if (refs.has(`character:${entry.id}`)) paths.add(entry.path);
	for (const entry of design.places) if (refs.has(`place:${entry.id}`)) paths.add(entry.path);
	for (const entry of design.resources) if (refs.has(`resource:${entry.id}`)) paths.add(entry.path);
	for (const entry of design.world) if (entry.id === "core" || refs.has(`world:${entry.id}`)) paths.add(entry.path);
	for (const entry of design.contracts) if (touched.has(entry.id)) paths.add(entry.path);
	for (const intent of design.intents) if (intentCovers(intent, beat, ordinals)) paths.add(intent.path);
	for (const artifact of candidate.artifacts)
		if (isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "story-index")
			paths.add(artifact.path);
	return [...paths].sort();
}

/**
 * 一份候选只解析一次 Design：时效与审稿主体要对每个 Beat 取闭包，逐个解析时 231 篇正文的作品（《三国演义》前五十回）
 * 光 `suim status` 就要 44 秒——每篇正文把九百多个设计文件解析两遍。候选在派生计算里不被修改，按对象缓存即可。
 */
const boundDesigns = new WeakMap<ArtifactCandidate, BoundDesign | null>();
function boundDesignOf(candidate: ArtifactCandidate): BoundDesign | undefined {
	let design = boundDesigns.get(candidate);
	if (design === undefined) {
		try {
			design = inspectStoryDesignCandidate(candidate).design;
		} catch {
			design = null;
		}
		boundDesigns.set(candidate, design);
	}
	return design ?? undefined;
}

function intentCovers(intent: CreativeIntent, beat: StoryBeat, ordinals: ReadonlyMap<string, number>): boolean {
	if (intent.target.kind === "book") return true;
	const from = ordinals.get(intent.target.fromStoryBeatId);
	const to = ordinals.get(intent.target.toStoryBeatId);
	return from !== undefined && to !== undefined && beat.ordinal >= from && beat.ordinal <= to;
}

export interface TextCurrency {
	storyBeatId: string;
	/** current：写成之后 Design 闭包没变；design-changed：变了，`changed` 列出哪些；uncommitted：候选里还没提交。 */
	state: "current" | "design-changed" | "uncommitted" | "missing";
	writtenAt?: string;
	changed: string[];
}

interface DerivedCache {
	written: Map<string, string>;
	snapshots: Map<string, Promise<ArtifactCandidate>>;
	digests: Map<string, Promise<ReadonlyMap<string, string>>>;
}

async function cacheFor(reader: RevisionHistoryReader, head: string, cache?: DerivedCache): Promise<DerivedCache> {
	return cache ?? { written: await writtenAtMap(reader, head), snapshots: new Map(), digests: new Map() };
}

function snapshotOf(reader: RevisionHistoryReader, cache: DerivedCache, revisionId: string) {
	let pending = cache.snapshots.get(revisionId);
	if (pending === undefined) {
		pending = reader.snapshot(revisionId);
		cache.snapshots.set(revisionId, pending);
	}
	return pending;
}

function digestsOf(reader: RevisionHistoryReader, cache: DerivedCache, revisionId: string) {
	let pending = cache.digests.get(revisionId);
	if (pending === undefined) {
		pending = reader.fileDigests(revisionId);
		cache.digests.set(revisionId, pending);
	}
	return pending;
}

async function changedBetween(
	reader: RevisionHistoryReader,
	cache: DerivedCache,
	from: string,
	to: string,
	paths: Iterable<string>,
): Promise<string[]> {
	if (from === to) return [];
	const [before, after] = await Promise.all([digestsOf(reader, cache, from), digestsOf(reader, cache, to)]);
	return [...new Set(paths)].filter((path) => before.get(path) !== after.get(path)).sort();
}

/**
 * story index 对一篇正文起作用的只是它那一段：所在卷（id、标题）与故事顺序里的前一个、后一个 Beat。
 * 整份比 index.yaml 时，全书末尾加一节就让前面每篇正文都变成 design-changed（斗破 host 运行加一卷续写，
 * 原作 27 篇全黄）——连载式写法每加一节都这样，信号就没用了。解析不了时返回 undefined，按整份比。
 */
function indexEntry(candidate: ArtifactCandidate, storyBeatId: string): string | undefined {
	const index = candidate.artifacts.find(
		(artifact) => isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "story-index",
	);
	if (index === undefined) return undefined;
	try {
		const parsed = parseYaml(decoder.decode(index.bytes), index.path) as {
			volumes?: { id?: unknown; title?: unknown; beat_ids?: unknown }[];
		};
		const order = (parsed.volumes ?? []).flatMap((volume) =>
			Array.isArray(volume.beat_ids) ? volume.beat_ids.map((beat) => ({ beat: String(beat), volume })) : [],
		);
		const at = order.findIndex((entry) => entry.beat === storyBeatId);
		const entry = order[at];
		if (entry === undefined) return undefined;
		return JSON.stringify([
			entry.volume.id,
			entry.volume.title,
			order[at - 1]?.beat ?? null,
			order[at + 1]?.beat ?? null,
		]);
	} catch {
		return undefined;
	}
}

/** 一份正文的 Design 时效：它最后一次提交时的 Design 闭包，与 head 下的同一闭包相比。 */
export async function textCurrency(
	reader: RevisionHistoryReader,
	head: string,
	candidate: ArtifactCandidate,
	storyBeatId: string,
	cache?: DerivedCache,
): Promise<TextCurrency> {
	const shared = await cacheFor(reader, head, cache);
	const path = `text/${storyBeatId}.md`;
	const present = candidate.artifacts.some(
		(artifact) =>
			isTargetArtifactIdentity(artifact.identity) &&
			artifact.identity.kind === "story-text" &&
			artifact.identity.localId === storyBeatId,
	);
	if (!present) return { storyBeatId, state: "missing", changed: [] };
	const writtenAt = shared.written.get(path);
	if (writtenAt === undefined) return { storyBeatId, state: "uncommitted", changed: [] };
	const then = await snapshotOf(reader, shared, writtenAt);
	const closure = new Set([...designClosurePaths(candidate, storyBeatId), ...designClosurePaths(then, storyBeatId)]);
	let changed = await changedBetween(reader, shared, writtenAt, head, closure);
	const indexPath = candidate.artifacts.find(
		(artifact) => isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "story-index",
	)?.path;
	if (indexPath !== undefined && changed.includes(indexPath)) {
		const before = indexEntry(then, storyBeatId);
		if (before !== undefined && before === indexEntry(candidate, storyBeatId))
			changed = changed.filter((path) => path !== indexPath);
	}
	return { storyBeatId, state: changed.length === 0 ? "current" : "design-changed", writtenAt, changed };
}

/** head 下全部正文的时效，按故事顺序。 */
export async function textCurrencies(
	reader: RevisionHistoryReader,
	head: string,
	candidate: ArtifactCandidate,
): Promise<TextCurrency[]> {
	const cache = await cacheFor(reader, head);
	const beats = inspectStoryDesignCandidate(candidate).design.story.beats.map((beat) => beat.id);
	const result: TextCurrency[] = [];
	for (const beat of beats) result.push(await textCurrency(reader, head, candidate, beat, cache));
	return result;
}

export interface CommittedReview {
	/** `review/<id>.md` 的 id。 */
	id: string;
	path: string;
	file: ReviewFile;
}

/** 当前候选里的全部审稿文件；解析不了的直接抛出，Checker 在提交时也会拦住它们。 */
export function reviewsIn(candidate: ArtifactCandidate): CommittedReview[] {
	return candidate.artifacts
		.filter((artifact) => isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "review")
		.map((artifact) => {
			const path = artifact.path;
			return { id: artifact.identity.localId, path, file: parseReviewFile(decoder.decode(artifact.bytes), path) };
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

export interface ReviewCurrency {
	state: "current" | "stale";
	changed: string[];
	/** 实际比较的起点版本；`candidate` 审稿解析成它首次提交的版本，尚未提交时没有。 */
	revision?: string;
	reason?: string;
}

function designPaths(candidate: ArtifactCandidate): string[] {
	return candidate.artifacts
		.filter((artifact) => isTargetArtifactIdentity(artifact.identity) && DESIGN_KINDS.has(artifact.identity.kind))
		.map((artifact) => artifact.path);
}

function sourcePaths(candidate: ArtifactCandidate, sourceId: string): string[] {
	return candidate.artifacts
		.filter(
			(artifact) =>
				isSourceArtifactIdentity(artifact.identity, sourceId) && artifact.identity.kind !== "source-note",
		)
		.map((artifact) => artifact.path);
}

/**
 * 一份审稿的主体路径：正文层是范围内每个 Beat 的正文加它的 Design 闭包，design 层是整个 Design，
 * source 层是那个 Source 的抽取文件。写审稿时用它算摘要，判时效时用它算当前摘要，两边同一个函数。
 */
export function reviewSubjectPaths(
	candidate: ArtifactCandidate,
	layer: ReviewFile["layer"],
	scope: ReviewFile["scope"],
): string[] {
	const subject = new Set<string>();
	if (layer === "design") {
		for (const path of designPaths(candidate)) subject.add(path);
	} else if (layer === "source") {
		if (scope.kind !== "source") throw new ArtifactError("invalid_review_subject", "source 审稿没有 sourceId");
		for (const path of sourcePaths(candidate, scope.sourceId)) subject.add(path);
	} else {
		const beats =
			scope.kind === "beats"
				? scope.storyBeatIds
				: inspectStoryDesignCandidate(candidate).design.story.beats.map((beat) => beat.id);
		for (const beat of beats) {
			subject.add(`text/${beat}.md`);
			for (const path of designClosurePaths(candidate, beat)) subject.add(path);
		}
	}
	return [...subject].sort();
}

/** 候选里这些路径当前的内容摘要；不在候选里的路径不出现在结果里。 */
export function subjectDigests(candidate: ArtifactCandidate, paths: readonly string[]): Map<string, string> {
	const byPath = new Map(candidate.artifacts.map((artifact) => [artifact.path, artifact.bytes]));
	const digests = new Map<string, string>();
	for (const path of paths) {
		const bytes = byPath.get(path);
		if (bytes !== undefined) digests.set(path, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
	}
	return digests;
}

/**
 * 审稿的时效：**比内容，不比时间**。审稿 frontmatter 里记着审的时候每个主体文件的摘要，
 * 拿它与当前候选的同一批路径比，摘要不同、文件没了、或者出现了审稿时不存在的主体文件，都是 stale。
 *
 * 曾经按版本比（审稿文件首次出现的版本 → head）。2026-09-16 第一次真实对话证明那样必然漏判：
 * Agent 的自然循环是「审 → 按意见改 → 一次提交」，审稿与改过的正文落在同一个 revision，
 * 比较区间为空，一份引文都已不在正文里的审稿被判成 current
 * （[记录](../../../../docs/validation/2026-09-16-first-real-session/README.md)）。
 *
 * `reader` 只用来给 `revision`（展示用的标签：`candidate` 审稿解析成它进版本的那一版），不参与判定。
 */
export async function reviewCurrency(
	reader: RevisionHistoryReader,
	head: string,
	candidate: ArtifactCandidate,
	review: { path: string; file: ReviewFile },
	cache?: DerivedCache,
): Promise<ReviewCurrency> {
	const file = review.file;
	const shared = await cacheFor(reader, head, cache);
	const revision = file.revision === CANDIDATE_REVISION ? shared.written.get(review.path) : file.revision;
	const label = revision === undefined ? {} : { revision };
	let paths: string[];
	try {
		paths = reviewSubjectPaths(candidate, file.layer, file.scope);
	} catch (error) {
		return { state: "stale", changed: [], ...label, reason: (error as Error).message };
	}
	const now = subjectDigests(candidate, paths);
	const changed = new Set<string>();
	for (const [path, digest] of file.subjects) if (now.get(path) !== digest) changed.add(path);
	// 审稿时不存在、现在成了主体的文件（新写的正文、新加的 Design）也让它过时。
	for (const path of now.keys()) if (!file.subjects.has(path)) changed.add(path);
	return {
		state: changed.size === 0 ? "current" : "stale",
		changed: [...changed].sort(),
		...label,
	};
}

export interface SourceCoverage {
	sourceId: string;
	materialCodePoints: number;
	/** 当前 `material.txt` 的 sha；笔记 frontmatter 的 `material_sha256` 要等于它才算数。 */
	materialSha256: string;
	/** 按 span 合并后的已读区间。 */
	covered: [number, number][];
	gaps: [number, number][];
	notes: { id: string; path: string; span: [number, number] }[];
}

/** notes 的 span 并集：只算 `material_sha256` 等于当前材料 sha 的笔记，材料换了旧笔记自然作废。 */
export function sourceCoverage(candidate: ArtifactCandidate, sourceId: string): SourceCoverage {
	const material = sourceMaterialFromCandidate(candidate, sourceId);
	const materialSha = sha256Hex(material.artifact.bytes);
	const points = codePointCount(material.text);
	const notes = candidate.artifacts
		.filter(
			(artifact) =>
				isSourceArtifactIdentity(artifact.identity, sourceId) && artifact.identity.kind === "source-note",
		)
		.map((artifact) => {
			const path = artifact.path;
			return { id: artifact.identity.localId, path, note: parseSourceNote(decoder.decode(artifact.bytes), path) };
		})
		.filter((entry) => entry.note.materialSha256 === materialSha)
		.sort((left, right) => left.note.span.start - right.note.span.start || left.id.localeCompare(right.id));
	const covered: [number, number][] = [];
	for (const entry of notes) {
		const start = entry.note.span.start;
		const end = Math.min(entry.note.span.end, points);
		if (start >= end) continue;
		const last = covered.at(-1);
		if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
		else covered.push([start, end]);
	}
	const gaps: [number, number][] = [];
	let cursor = 0;
	for (const [start, end] of covered) {
		if (start > cursor) gaps.push([cursor, start]);
		cursor = end;
	}
	if (cursor < points) gaps.push([cursor, points]);
	return {
		sourceId,
		materialCodePoints: points,
		materialSha256: materialSha,
		covered,
		gaps,
		notes: notes.map((entry) => ({
			id: entry.id,
			path: entry.path,
			span: [entry.note.span.start, entry.note.span.end],
		})),
	};
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export interface ReleaseReadiness {
	publishable: boolean;
	blockers: string[];
	texts: TextCurrency[];
	/** 最近一份 current 的全书正文审稿；没有就发不了。 */
	review?: { id: string; verdict: ReviewFile["draft"]["verdict"] };
}

/** 可发布 = 每个 Beat 都有正文、每份正文 current、存在一份 current 的全书正文审稿。verdict 不参与，原样带出。 */
export async function releaseReadiness(
	reader: RevisionHistoryReader,
	head: string,
	candidate: ArtifactCandidate,
): Promise<ReleaseReadiness> {
	const blockers: string[] = [];
	try {
		validateCompleteStoryTextCandidate(candidate);
	} catch (error) {
		blockers.push(error instanceof Error ? error.message : String(error));
	}
	const cache = await cacheFor(reader, head);
	const beats = inspectStoryDesignCandidate(candidate).design.story.beats.map((beat) => beat.id);
	const texts: TextCurrency[] = [];
	for (const beat of beats) texts.push(await textCurrency(reader, head, candidate, beat, cache));
	for (const text of texts)
		if (text.state !== "current")
			blockers.push(
				`正文 ${text.storyBeatId} ${text.state}${text.changed.length ? `：${text.changed.join("、")}` : ""}`,
			);
	let review: ReleaseReadiness["review"];
	const wholeBook = reviewsIn(candidate).filter(
		(item) => item.file.layer === "text" && item.file.scope.kind === "book",
	);
	// 最近写的排前面：同样 current 时取最新的一份。
	wholeBook.sort((left, right) => {
		const leftAt = cache.written.get(left.path) ?? "";
		const rightAt = cache.written.get(right.path) ?? "";
		return revisionOrder(rightAt, cache) - revisionOrder(leftAt, cache) || left.id.localeCompare(right.id);
	});
	for (const item of wholeBook) {
		const currency = await reviewCurrency(reader, head, candidate, item, cache);
		if (currency.state === "current") {
			review = { id: item.id, verdict: item.file.draft.verdict };
			break;
		}
	}
	if (review === undefined) blockers.push("没有 current 的全书正文审稿");
	return { publishable: blockers.length === 0, blockers, texts, ...(review === undefined ? {} : { review }) };
}

function revisionOrder(revisionId: string, cache: DerivedCache): number {
	// written 里的 revision 只在祖先链上出现；用它在 map 里的插入顺序近似先后（同一 head 下稳定）。
	let index = 0;
	for (const value of new Set(cache.written.values())) {
		if (value === revisionId) return index;
		index += 1;
	}
	return -1;
}
