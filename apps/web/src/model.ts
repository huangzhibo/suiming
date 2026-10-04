import type { LocalCommandOutput } from "@suiming/sdk";
import { propertyLabel } from "./artifact-properties.js";

export type SessionSummary = LocalCommandOutput<"session.list">["sessions"][number];
/**
 * 作品投影加上对话列表。对话列表只有 `session.list` 一份（`workspace.show` 不再带），而且只取
 * Agent 对话：`suim rank` 的实验 session 不是作者的对话，原来会混进列表、甚至被默认选中。
 */
export type WorkspaceData = LocalCommandOutput<"workspace.show"> & { sessions: SessionSummary[] };
export type FileEntry = WorkspaceData["files"][number];
export type ReviewReport = LocalCommandOutput<"workspace.reviews">[number];

/** 页面地址：artifact 路径直接使用目录路径；其余页面用前缀区分，不新增持久实体。 */
export type PageKind = "artifact" | "file" | "diff" | "empty" | "spine" | "check" | "issue" | "version";
export const diffPage = (path: string) => `diff:${path}`;
export const filePage = (path: string) => `file:${path}`;
export const SPINE_PAGE = "spine";
export const CHECK_PAGE = "check";
export const CANDIDATE_VERSION = "version:candidate";
/** checkout 里还没提交的那一份：作者与 Agent 共用，标签、版本列表与页面标题都叫这个名字。 */
export const CANDIDATE_TITLE = "未提交的修改";
export const issuePage = (reportId: string) => `issue:${reportId}`;
export const versionPage = (revisionId: string) => `version:${revisionId}`;

export function pageKind(page: string): PageKind {
	if (!page || page === "empty:") return "empty";
	if (page.startsWith("diff:")) return "diff";
	if (page.startsWith("file:")) return "file";
	if (page === SPINE_PAGE) return "spine";
	if (page === CHECK_PAGE) return "check";
	if (page.startsWith("issue:")) return "issue";
	if (page.startsWith("version:")) return "version";
	return "artifact";
}
export const pageTarget = (page: string) => page.slice(page.indexOf(":") + 1);

/** 作品对象在界面上的中文名：标题行、面包屑、依据栏、邻域图与「被引用」分组共用这一份。 */
export const KIND_LABEL: Record<string, string> = {
	"story-beat": "情节",
	"story-text": "正文",
	"story-contract": "读者期待",
	character: "人物",
	place: "地点",
	resource: "资源",
	world: "世界",
	intent: "创作意图",
	"style-evidence": "风格参照",
	"reference-material": "参考资料",
	"reference-research": "调研资料",
	"story-index": "故事目录",
	"release-chapter": "发布章节",
	review: "审稿",
	"source-note": "原作笔记",
};
/** 邻域图按种类着色，取全局 token（style.css），不写死色值。 */
export const KIND_COLOR: Record<string, string> = {
	"story-beat": "var(--foreground)",
	"story-text": "var(--foreground)",
	character: "var(--success)",
	"story-contract": "var(--amber)",
	place: "var(--muted-foreground)",
	resource: "var(--muted-foreground)",
	world: "var(--muted-foreground)",
	intent: "var(--purple)",
};
export const textPathFor = (beatId: string) => `text/${beatId}.md`;

export class Book {
	readonly data: WorkspaceData;
	readonly byPath: Map<string, FileEntry>;
	readonly order: string[];
	readonly links: Link[];
	readonly #byKindId: Map<string, FileEntry>;
	constructor(data: WorkspaceData) {
		this.data = data;
		this.byPath = new Map(data.files.map((file) => [file.path, file]));
		this.#byKindId = new Map(
			data.files.filter((file) => file.namespace === "target").map((file) => [`${file.kind}:${file.localId}`, file]),
		);
		const declared = data.volumes.flatMap((volume) => volume.beatIds);
		const undeclared = data.files
			.filter(
				(file) => file.kind === "story-beat" && file.namespace === "target" && !declared.includes(file.localId),
			)
			.map((file) => file.localId)
			.sort();
		this.order = [...declared, ...undeclared];
		this.links = deriveLinks(this);
	}
	file(kind: string, localId: string): FileEntry | undefined {
		return this.#byKindId.get(`${kind}:${localId}`);
	}
	beat(beatId: string): FileEntry | undefined {
		return this.file("story-beat", beatId);
	}
	text(beatId: string): FileEntry | undefined {
		return this.file("story-text", beatId);
	}
	volumeOf(beatId: string) {
		return this.data.volumes.find((volume) => volume.beatIds.includes(beatId));
	}
	ordinal(beatId: string): number {
		return this.order.indexOf(beatId);
	}
	title(file: FileEntry | undefined): string {
		if (!file) return "";
		if (file.kind === "story-text") {
			const beat = this.beat(file.localId);
			return `${beat?.title ?? file.localId} · 正文`;
		}
		if (file.kind === "story-index") return "目录 · index.yaml";
		const name = file.frontmatter.name;
		// Contract、世界设定没有 title / name 字段，中文名在正文的 # 标题里；id 可能是拼音，只作最后的退路。
		return file.title ?? (typeof name === "string" ? name : undefined) ?? file.heading ?? file.localId;
	}
	/** 页面标题：artifact 用作品标题，其它页面用固定前缀。 */
	pageTitle(page: string, reviews: ReviewReport[] = []): string {
		switch (pageKind(page)) {
			case "empty":
				return "新标签页";
			case "file":
				return pageTarget(page).split("/").at(-1) ?? page;
			case "diff": {
				const path = pageTarget(page);
				const file = this.byPath.get(path);
				if (file?.kind === "story-text") return `${this.title(file)}差异`;
				const beatId = this.order.find((id) => textPathFor(id) === path);
				if (beatId) return `${this.beatTitle(beatId)} · 正文差异`;
				return `${this.title(file) || path.split("/").at(-1)} · ${file?.kind === "story-beat" ? "设计差异" : "版本差异"}`;
			}
			case "spine":
				return "故事轴";
			case "check":
				return "检查结果";
			case "issue": {
				const report = reviews.find((report) => report.id === pageTarget(page));
				return `审稿 · ${report ? report.summary.slice(0, 24) : shortId(pageTarget(page))}`;
			}
			case "version": {
				const target = pageTarget(page);
				return target === "candidate" ? CANDIDATE_TITLE : this.revisionLabel(target);
			}
			default:
				return this.title(this.byPath.get(page)) || page;
		}
	}
	revisionLabel(revisionId: string): string {
		const index = this.data.revisions.findIndex((revision) => revision.id === revisionId);
		return index === -1 ? shortId(revisionId) : `r${index + 1}`;
	}
	get headLabel(): string {
		return this.revisionLabel(this.data.revisionId);
	}
	beatTitle(beatId: string): string {
		return this.beat(beatId)?.title ?? beatId;
	}
	/** 一篇正文相对 Design 的时效（从版本历史派生）；没有正文时为 undefined。 */
	currencyOf(beatId: string) {
		const entry = this.data.storyText.find((item) => item.storyBeatId === beatId);
		return entry === undefined || entry.state === "missing" ? undefined : entry;
	}
	currencyLabel(beatId: string): { text: string; tone: "green" | "amber" | "gray" } | undefined {
		const entry = this.currencyOf(beatId);
		if (!entry) return undefined;
		const written = entry.writtenAt === undefined ? "" : `写于 ${this.revisionLabel(entry.writtenAt)} · `;
		if (entry.state === "current") return { text: `${written}设计未变`, tone: "green" };
		// 正文还没提交：页面上已经有「未提交」，这里不再说一遍。
		if (entry.state === "uncommitted") return undefined;
		return { text: `${written}设计已变：${entry.changed.length} 个文件`, tone: "amber" };
	}
	/** 全书正文时效一句话：多少篇已提交、其中多少篇的 Design 已变。 */
	currencySummary(): string {
		const texts = this.data.storyText.filter((item) => item.state !== "missing");
		const changed = texts.filter((item) => item.state === "design-changed").length;
		if (texts.length === 0) return "还没有已提交正文";
		return changed === 0 ? `正文 ${texts.length} 篇 · 设计未变` : `正文 ${texts.length} 篇 · ${changed} 篇的设计已变`;
	}
	/** 区间内（含两端）引用某个 identity 的 Beat 数；未刷选时传入全书范围。 */
	refCountInRange(targetPath: string, start: number, end: number): number {
		return this.links.filter((link) => {
			if (link.to !== targetPath || !link.key.startsWith("refs.")) return false;
			const ordinal = this.ordinal(this.byPath.get(link.from)?.localId ?? "");
			return ordinal >= start && ordinal <= end;
		}).length;
	}
	/** `deadline: book_end` 的说法；作者在 index 声明全书未完待续时一并说出来，免得读成已到期。 */
	get bookEndLabel(): string {
		return this.data.openEnded ? "全书结束前（全书未完待续）" : "全书结束前";
	}
	contractState(contractId: string, cursorIndex: number): { label: string; opened: boolean; resolved: boolean } {
		const contract = this.file("story-contract", contractId);
		const deadline = typeof contract?.frontmatter.deadline === "string" ? contract.frontmatter.deadline : undefined;
		const opens = this.links.filter((link) => link.to === contract?.path && link.key === "contracts.open");
		const resolves = this.links.filter((link) => link.to === contract?.path && link.key === "contracts.resolve");
		const openAt = Math.min(...opens.map((link) => this.ordinal(this.byPath.get(link.from)?.localId ?? "")));
		const resolveAt = Math.min(...resolves.map((link) => this.ordinal(this.byPath.get(link.from)?.localId ?? "")));
		const opened = opens.length > 0 && openAt <= cursorIndex;
		const resolved = resolves.length > 0 && resolveAt <= cursorIndex;
		if (!opened) return { label: "尚未建立", opened, resolved };
		if (resolved) return { label: "已回应", opened, resolved };
		// book_end 在最后一个 Beat 到期；作者声明全书未完待续时不到期（与故事轴 contractLane 同一条规则）
		const deadlineIndex =
			deadline === "book_end"
				? this.data.openEnded
					? -1
					: this.order.length - 1
				: deadline
					? this.ordinal(deadline)
					: -1;
		if (deadlineIndex >= 0 && cursorIndex >= deadlineIndex) return { label: "已到期限，尚未回应", opened, resolved };
		return { label: "等待回应", opened, resolved };
	}
}

export interface Link {
	from: string;
	to: string;
	/** frontmatter 键路径，如 refs.character、contracts.open、subjects.character、deadline。 */
	key: string;
}
const KEY_KINDS: Record<string, string[]> = {
	character: ["character"],
	place: ["place"],
	resource: ["resource"],
	world: ["world"],
	beat: ["story-beat"],
	deadline: ["story-beat"],
	open: ["story-contract"],
	advance: ["story-contract"],
	resolve: ["story-contract"],
	fromStoryBeatId: ["story-beat"],
	toStoryBeatId: ["story-beat"],
	style_refs: ["style-evidence"],
	holder: ["character", "place"],
	location: ["place"],
};
/** 从 frontmatter 派生确定性引用：值与另一份 artifact 的 localId 相同即成链，键名限定目标种类。 */
function deriveLinks(book: Book): Link[] {
	const links: Link[] = [];
	const visit = (from: string, value: unknown, keys: string[]) => {
		if (typeof value === "string") {
			const kinds = [...keys]
				.reverse()
				.map((key) => KEY_KINDS[key])
				.find(Boolean);
			if (!kinds) return;
			for (const kind of kinds) {
				const target = book.file(kind, value);
				if (target && target.path !== from) {
					links.push({ from, to: target.path, key: keys.filter((key) => !/^\d+$/u.test(key)).join(".") });
					return;
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => {
				visit(from, item, [...keys, String(index)]);
			});
		} else if (value && typeof value === "object")
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) visit(from, item, [...keys, key]);
	};
	for (const file of book.data.files) {
		if (file.namespace !== "target") continue;
		visit(file.path, file.frontmatter, []);
	}
	return links;
}

export interface BacklinkGroup {
	label: string;
	items: { path: string; title: string; meta: string }[];
}
/** 被引用：由其它 artifact 的 frontmatter 派生。 */
export function backlinksFor(book: Book, path: string): BacklinkGroup[] {
	const groups = new Map<string, BacklinkGroup>();
	const file = book.byPath.get(path);
	const push = (label: string, item: BacklinkGroup["items"][number]) => {
		const group = groups.get(label) ?? { label, items: [] };
		if (!group.items.some((existing) => existing.path === item.path && existing.meta === item.meta))
			group.items.push(item);
		groups.set(label, group);
	};
	for (const link of book.links) {
		if (link.to !== path) continue;
		const from = book.byPath.get(link.from);
		if (!from) continue;
		const isBeat = from.kind === "story-beat";
		push(`${KIND_LABEL[from.kind] ?? from.kind}的「${propertyLabel(link.key)}」`, {
			path: from.path,
			title: book.title(from),
			meta: isBeat ? from.localId : (KIND_LABEL[from.kind] ?? from.kind),
		});
	}
	if (file?.kind === "story-beat") {
		const text = book.text(file.localId);
		if (text)
			push("这一节的正文", {
				path: text.path,
				title: book.title(text),
				meta: `${text.codePoints.toLocaleString()} 字`,
			});
	}
	if (file?.kind === "story-text") {
		const beat = book.beat(file.localId);
		if (beat) push("这篇正文的情节设计", { path: beat.path, title: book.title(beat), meta: beat.localId });
	}
	return [...groups.values()];
}
/** 正向引用：本 artifact frontmatter 指向的其它 artifact，按键分组。 */
export function outlinksFor(book: Book, path: string): { key: string; path: string; title: string }[] {
	return book.links
		.filter((link) => link.from === path)
		.map((link) => ({ key: link.key, path: link.to, title: book.title(book.byPath.get(link.to)) }));
}

export const stripFrontmatter = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
export const paragraphs = (content: string) =>
	stripFrontmatter(content)
		.split(/\n\s*\n/u)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
export const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 10)}…` : id);
export const codePoints = (text: string) => [...text].length;

/** 审稿报告挂到 artifact：以被审路径为准；StoryBeat 也算上同 id 正文的报告。 */
export function reviewsFor(book: Book, reviews: ReviewReport[], path: string): ReviewReport[] {
	const file = book.byPath.get(path);
	const paths = new Set([path]);
	if (file?.kind === "story-beat") paths.add(textPathFor(file.localId));
	if (file?.kind === "story-text") paths.add(book.beat(file.localId)?.path ?? "");
	return reviews.filter((report) => report.paths.some((subject) => paths.has(subject)));
}
