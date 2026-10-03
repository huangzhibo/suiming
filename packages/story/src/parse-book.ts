import { BookParseError } from "./book-error.js";
import {
	CharacterHeaderSchema,
	CreativeIntentSchema,
	type FAMILY_LINK_KINDS,
	IDENTITY_ID_PATTERN,
	IdentityHeaderSchema,
	INTENT_ID_PATTERN,
	STORY_CONTRACT_ID_PATTERN,
	STYLE_REF_PATTERN,
	StoryContractHeaderSchema,
} from "./book-schema.js";
import { sha256Hex } from "./canonical.js";
import { DiagnosticCollector } from "./collector.js";
import type { Diagnostic } from "./errors.js";
import { SuimError } from "./errors.js";
import { extractExactIntentFragments } from "./intent-exact.js";
import type { StateProjection } from "./ir/index.js";
import { parseMarkdownDocument } from "./markdown.js";
import { flattenReferenceGroups, groupedReferencePointer, type ReferenceGroups } from "./reference-groups.js";
import { checkedBookSchema } from "./schema-check.js";
import { compileStateProjection } from "./state-projection.js";
import { buildContractLifecycles } from "./story-contract.js";
import { bindStoryOutline, parseStoryIndexYaml, type StoryIndexDocument, type StoryOutline } from "./story-outline.js";

export { BookParseError } from "./book-error.js";

export type IdentityKind = "character" | "place" | "resource";

export interface IdentityEntry {
	id: string;
	name: string;
	aliases: string[];
	initial: Record<string, string | boolean>;
	body: string;
	path: string;
}

export type FamilyLinkKind = (typeof FAMILY_LINK_KINDS)[number];

export interface FamilyLink {
	kind: FamilyLinkKind;
	character: string;
	role?: string;
}

export interface CharacterEntry extends IdentityEntry {
	family: FamilyLink[];
}

export type PlaceEntry = IdentityEntry;
export type ResourceEntry = IdentityEntry;

export interface WorldEntry {
	id: string;
	body: string;
	path: string;
}

export interface StoryContract {
	id: string;
	path: string;
	subjects: string[];
	deadline: { kind: "story_beat"; storyBeatId: string } | { kind: "book_end" };
	body: string;
}

export type IntentTarget = { kind: "book" } | { kind: "range"; fromStoryBeatId: string; toStoryBeatId: string };

export interface CreativeIntent {
	id: string;
	path: string;
	appliesTo: "design" | "text";
	target: IntentTarget;
	subjects: string[];
	styleRefs: string[];
	body: string;
	exactFragments: string[];
	sha256: string;
}

export interface BoundBook {
	story: StoryOutline;
	stateProjection: StateProjection;
	characters: CharacterEntry[];
	places: PlaceEntry[];
	resources: ResourceEntry[];
	world: WorldEntry[];
	contracts: StoryContract[];
	intents: CreativeIntent[];
	/** 不阻塞绑定的提示，例如未被任何 StoryBeat 引用的 World 文档。 */
	warnings: Diagnostic[];
	scope: BoundBookScope;
}

const STYLE_ID = new RegExp(STYLE_REF_PATTERN);
const IDENTITY_ID = new RegExp(IDENTITY_ID_PATTERN);
const INTENT_ID = new RegExp(INTENT_ID_PATTERN);
const STORY_CONTRACT_ID = new RegExp(STORY_CONTRACT_ID_PATTERN);

function requireNfc(value: string, label: string): void {
	if (value !== value.normalize("NFC")) {
		throw new BookParseError("invalid_document", `${label} must use Unicode NFC normalization`);
	}
}

export function identityRef(kind: IdentityKind, id: string): string {
	return `${kind}:${id}`;
}

export function parseIdentityMarkdown(
	markdown: string,
	id: string,
	kind: IdentityKind,
	path = `world/${kind === "character" ? "characters" : `${kind}s`}/${id}.md`,
): IdentityEntry {
	if (!IDENTITY_ID.test(id)) throw new BookParseError("invalid_document", `${kind} id 不合法：${id}`);
	requireNfc(id, `${kind} id`);
	const document = parseMarkdownDocument(markdown, path);
	checkedBookSchema(IdentityHeaderSchema, document.frontmatter, `${path} frontmatter`, {
		path,
		pointerPrefix: "/frontmatter",
	});
	if (document.body.length === 0) {
		throw new BookParseError("invalid_document", `${path} 的正文不能为空，要描述这个 ${kind}`, [
			{ path, pointer: "/body", message: `正文不能为空，要描述这个 ${kind}` },
		]);
	}
	return {
		id,
		name: (document.frontmatter.name as string | undefined) ?? id,
		aliases: [...((document.frontmatter.aliases as string[] | undefined) ?? [])],
		initial: { ...((document.frontmatter.initial as Record<string, string | boolean> | undefined) ?? {}) },
		body: document.body,
		path,
	};
}

export function parseCharacterMarkdown(markdown: string, id: string, path?: string): CharacterEntry {
	const resolvedPath = path ?? `world/characters/${id}.md`;
	if (!IDENTITY_ID.test(id)) throw new BookParseError("invalid_document", `人物 id 不合法：${id}`);
	requireNfc(id, "character id");
	const document = parseMarkdownDocument(markdown, resolvedPath);
	checkedBookSchema(CharacterHeaderSchema, document.frontmatter, `${resolvedPath} frontmatter`, {
		path: resolvedPath,
		pointerPrefix: "/frontmatter",
	});
	if (document.body.length === 0) {
		throw new BookParseError("invalid_document", `${resolvedPath} 的正文不能为空，要描述这个人物`, [
			{ path: resolvedPath, pointer: "/body", message: "正文不能为空，要描述这个人物" },
		]);
	}
	const family = ((document.frontmatter.family as FamilyLink[] | undefined) ?? []).map((link) => ({ ...link }));
	const familyKeys = family.map((link) => `${link.kind}:${link.character}`);
	if (new Set(familyKeys).size !== familyKeys.length) {
		throw new BookParseError("invalid_document", `${resolvedPath} 的家族关系有重复`, [
			{ path: resolvedPath, pointer: "/frontmatter/family", message: "重复的家族关系" },
		]);
	}
	for (const [index, link] of family.entries()) {
		requireNfc(link.character, `${resolvedPath} family[${index}].character`);
		if (link.character === id) {
			throw new BookParseError("invalid_document", `${resolvedPath} 的家族关系指向了自己`, [
				{ path: resolvedPath, pointer: `/frontmatter/family/${index}/character`, message: "家族关系指向了自己" },
			]);
		}
	}
	return {
		id,
		name: (document.frontmatter.name as string | undefined) ?? id,
		aliases: [...((document.frontmatter.aliases as string[] | undefined) ?? [])],
		initial: { ...((document.frontmatter.initial as Record<string, string | boolean> | undefined) ?? {}) },
		family,
		body: document.body,
		path: resolvedPath,
	};
}

export function parsePlaceMarkdown(markdown: string, id: string, path?: string): PlaceEntry {
	return parseIdentityMarkdown(markdown, id, "place", path);
}

export function parseResourceMarkdown(markdown: string, id: string, path?: string): ResourceEntry {
	return parseIdentityMarkdown(markdown, id, "resource", path);
}

export function parseStoryContractMarkdown(
	markdown: string,
	id: string,
	path = `outline/contracts/${id}.md`,
): StoryContract {
	if (!STORY_CONTRACT_ID.test(id)) throw new BookParseError("invalid_document", `StoryContract id 不合法：${id}`);
	requireNfc(id, "StoryContract id");
	const document = parseMarkdownDocument(markdown, path);
	checkedBookSchema(StoryContractHeaderSchema, document.frontmatter, `${path} frontmatter`, {
		path,
		pointerPrefix: "/frontmatter",
	});
	if (document.body.length === 0) {
		throw new BookParseError("invalid_document", `${path} 的正文不能为空，要描述这个 StoryContract`, [
			{ path, pointer: "/body", message: "StoryContract 的正文不能为空" },
		]);
	}
	const rawDeadline = (document.frontmatter.deadline as string | undefined) ?? "book_end";
	const subjects = flattenReferenceGroups((document.frontmatter.subjects as ReferenceGroups | undefined) ?? {});
	for (const [index, subject] of subjects.entries()) {
		requireNfc(subject, `${path} subjects[${index}]`);
	}
	return {
		id,
		path,
		subjects,
		deadline: rawDeadline === "book_end" ? { kind: "book_end" } : { kind: "story_beat", storyBeatId: rawDeadline },
		body: document.body,
	};
}

export function parseCreativeIntent(markdown: string, id: string, path = `intent/${id}.md`): CreativeIntent {
	if (!INTENT_ID.test(id)) throw new BookParseError("invalid_document", `Intent id 不合法：${id}`);
	requireNfc(id, "Intent id");
	const document = parseMarkdownDocument(markdown, path);
	checkedBookSchema(CreativeIntentSchema, document.frontmatter, `${path} frontmatter`, {
		path,
		pointerPrefix: "/frontmatter",
	});
	if (document.body.length === 0) {
		throw new BookParseError("invalid_document", `${path} 的正文不能为空`, [
			{ path, pointer: "/body", message: "Intent 的正文不能为空" },
		]);
	}
	const rawTarget = document.frontmatter.target;
	const styleRefs = [...((document.frontmatter.style_refs as string[] | undefined) ?? [])];
	const subjects = flattenReferenceGroups((document.frontmatter.subjects as ReferenceGroups | undefined) ?? {});
	for (const [index, subject] of subjects.entries()) {
		requireNfc(subject, `${path} subjects[${index}]`);
	}
	for (const ref of styleRefs) {
		if (!STYLE_ID.test(ref)) throw new BookParseError("invalid_document", `style_ref 不合法：${ref}`);
	}
	const target: IntentTarget =
		rawTarget === undefined || rawTarget === "book"
			? { kind: "book" }
			: {
					kind: "range",
					fromStoryBeatId: (rawTarget as Record<string, string>).from_beat_id as string,
					toStoryBeatId: (rawTarget as Record<string, string>).to_beat_id as string,
				};
	let exactFragments: string[];
	try {
		exactFragments = extractExactIntentFragments(document.body, path);
	} catch (error) {
		if (!(error instanceof SuimError)) throw error;
		throw new BookParseError("invalid_document", error.message, [{ path, pointer: "/body", message: error.message }]);
	}
	return {
		id,
		path,
		appliesTo: (document.frontmatter.applies_to as CreativeIntent["appliesTo"] | undefined) ?? "design",
		target,
		subjects,
		styleRefs,
		body: document.body,
		exactFragments,
		sha256: sha256Hex(document.body),
	};
}

export interface BookSources {
	storyIndex: unknown;
	beats: readonly { volumeId: string; beatId: string; path: string; markdown: string }[];
	characters: readonly { id: string; path: string; markdown: string }[];
	places: readonly { id: string; path: string; markdown: string }[];
	resources: readonly { id: string; path: string; markdown: string }[];
	world: readonly { id: string; path: string; body: string }[];
	contracts: readonly { id: string; path: string; markdown: string }[];
	intents: readonly { id: string; path: string; markdown: string }[];
	styleIds: readonly string[];
}

export interface BindBookOptions {
	/** Source extraction 没有 style evidence，可关闭 style_refs 存在性检查。 */
	enforceStyleEvidence?: boolean;
	/**
	 * 故事在此边界之后仍会继续：`book_end` 的 Contract 不算到期。
	 * Source 的材料边界是 open-ended；全书 Design 只有 index 声明了 `open_ended: true`
	 * （作者说全书未完待续）才是。
	 */
	openEnded?: boolean;
}

export interface BoundBookScope {
	openEnded: boolean;
}

function parseAll<T>(collector: DiagnosticCollector, items: readonly T[], parse: (item: T) => unknown): unknown[] {
	return items.flatMap((item) => {
		const parsed = collector.collect(() => parse(item));
		return parsed === undefined ? [] : [parsed];
	});
}

/**
 * 把一组作品文件绑定为可检查的 Design。
 *
 * 每个文档单独解析，解析失败的文档被跳过并记录诊断；跨文档引用、家族边、Contract 生命周期
 * 与硬状态编译全部走完后，才以一次 BookParseError 抛出全部错误。不阻塞的问题进入 `warnings`。
 */
export function bindBookDocuments(sources: BookSources, options: BindBookOptions = {}): BoundBook {
	const enforceStyleEvidence = options.enforceStyleEvidence ?? true;
	const scope: BoundBookScope = { openEnded: options.openEnded ?? false };
	const collector = new DiagnosticCollector();
	const index = collector.collect(() => parseStoryIndexYaml(sources.storyIndex));
	if (index === undefined) collector.throwIfFailed("Design");
	if ((index as StoryIndexDocument).openEnded) scope.openEnded = true;
	const story = bindStoryOutline(index as StoryIndexDocument, sources.beats, collector);
	const characters = parseAll(collector, sources.characters, (item) =>
		parseCharacterMarkdown(item.markdown, item.id, item.path),
	) as CharacterEntry[];
	const places = parseAll(collector, sources.places, (item) =>
		parsePlaceMarkdown(item.markdown, item.id, item.path),
	) as PlaceEntry[];
	const resources = parseAll(collector, sources.resources, (item) =>
		parseResourceMarkdown(item.markdown, item.id, item.path),
	) as ResourceEntry[];
	const world = sources.world.map((item) => ({ id: item.id, path: item.path, body: item.body }));
	const contracts = parseAll(collector, sources.contracts, (item) =>
		parseStoryContractMarkdown(item.markdown, item.id, item.path),
	) as StoryContract[];
	const intents = parseAll(collector, sources.intents, (item) =>
		parseCreativeIntent(item.markdown, item.id, item.path),
	) as CreativeIntent[];
	const stateProjection = compileStateProjection(story, { characters, places, resources }, collector);
	const beatIds = new Set(story.beats.map((beat) => beat.id));
	const knownIdentityRefs = new Set([
		...characters.map((entry) => identityRef("character", entry.id)),
		...places.map((entry) => identityRef("place", entry.id)),
		...resources.map((entry) => identityRef("resource", entry.id)),
	]);
	const knownCharacterIds = new Set(characters.map((entry) => entry.id));
	const knownStoryRefs = new Set([...knownIdentityRefs, ...world.map((entry) => `world:${entry.id}`)]);
	const symmetricFamilyLinks = new Map<string, { path: string; index: number }>();
	for (const character of characters) {
		for (const [index, link] of character.family.entries()) {
			if (!knownCharacterIds.has(link.character)) {
				collector.report("missing_context_reference", [
					{
						path: character.path,
						pointer: `/frontmatter/family/${index}/character`,
						message: `找不到人物：${link.character}`,
						hint: "创建这个人物，或者换掉这条家族关系",
					},
				]);
				continue;
			}
			if (link.kind !== "spouse" && link.kind !== "sibling") continue;
			const pair = [character.id, link.character].sort();
			const key = `${link.kind}:${pair.join(":")}`;
			const previous = symmetricFamilyLinks.get(key);
			if (previous !== undefined) {
				collector.report("invalid_document", [
					{
						path: character.path,
						pointer: `/frontmatter/family/${index}`,
						message: `同一条 ${link.kind} 关系已经在 ${previous.path} 里声明过`,
						hint: "对称关系只在一个人物里写一次，反向那条会自动推出",
					},
				]);
				continue;
			}
			symmetricFamilyLinks.set(key, { path: character.path, index });
		}
	}
	for (const contract of contracts) {
		if (contract.deadline.kind === "story_beat" && !beatIds.has(contract.deadline.storyBeatId)) {
			collector.report("missing_context_reference", [
				{
					path: contract.path,
					pointer: "/frontmatter/deadline",
					message: `找不到 StoryBeat ${contract.deadline.storyBeatId}`,
				},
			]);
		}
		for (const [index, subject] of contract.subjects.entries()) {
			if (subject.startsWith("secret:") || knownStoryRefs.has(subject)) continue;
			collector.report("missing_context_reference", [
				{
					path: contract.path,
					pointer: groupedReferencePointer("subjects", contract.subjects, index),
					message: `找不到主体 ${subject}`,
				},
			]);
		}
	}
	const styleIds = new Set(sources.styleIds);
	for (const beat of story.beats) {
		for (const [index, ref] of beat.refs.entries()) {
			if (ref.startsWith("secret:") || ref.startsWith("beat:") || knownStoryRefs.has(ref)) continue;
			collector.report("missing_context_reference", [
				{
					path: beat.path,
					pointer: groupedReferencePointer("refs", beat.refs, index),
					message: `找不到引用 ${ref}`,
					hint: "创建被引用的 World 文档或身份，或者换掉这条引用",
				},
			]);
		}
	}
	for (const intent of intents) {
		for (const [index, subject] of intent.subjects.entries()) {
			if (subject.startsWith("secret:") || knownStoryRefs.has(subject)) continue;
			collector.report("missing_context_reference", [
				{
					path: intent.path,
					pointer: groupedReferencePointer("subjects", intent.subjects, index),
					message: `找不到主体 ${subject}`,
				},
			]);
		}
		if (!enforceStyleEvidence) continue;
		for (const [index, ref] of intent.styleRefs.entries()) {
			if (styleIds.has(ref)) continue;
			collector.report("missing_context_reference", [
				{
					path: intent.path,
					pointer: `/frontmatter/style_refs/${index}`,
					message: `${ref} 缺少对应的文风文件`,
				},
			]);
		}
	}
	const referencedStoryRefs = new Set(story.beats.flatMap((beat) => beat.refs));
	for (const entry of world) {
		if (entry.id === "core" || referencedStoryRefs.has(`world:${entry.id}`)) continue;
		collector.warn([
			{
				path: entry.path,
				message: `world:${entry.id} 没有被任何 StoryBeat 引用`,
				hint: `在依赖它的每个 StoryBeat 里加上 world:${entry.id}；全书通用的设定挪到 world/core.md；或者删掉这份文档`,
			},
		]);
	}
	buildContractLifecycles(story, contracts, collector);
	collector.throwIfFailed("Design");
	return {
		story,
		stateProjection,
		characters,
		places,
		resources,
		world,
		contracts,
		intents,
		warnings: collector.warnings,
		scope,
	};
}
