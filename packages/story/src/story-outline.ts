import { BookParseError } from "./book-error.js";
import { STORY_BEAT_ID_PATTERN, VOLUME_ID_PATTERN } from "./book-patterns.js";
import { StoryBeatHeaderSchema, StoryIndexYamlSchema } from "./book-schema.js";
import type { DiagnosticCollector } from "./collector.js";
import { parseMarkdownDocument } from "./markdown.js";
import { flattenReferenceGroups, groupedReferencePointer, type ReferenceGroups } from "./reference-groups.js";
import { checkedBookSchema } from "./schema-check.js";
import { validateStoryDependencies } from "./story-dependencies.js";

export { STORY_BEAT_ID_PATTERN, VOLUME_ID_PATTERN } from "./book-patterns.js";

const VOLUME_ID = new RegExp(VOLUME_ID_PATTERN);
const STORY_BEAT_ID = new RegExp(STORY_BEAT_ID_PATTERN);

export interface StoryIndexVolume {
	id: string;
	title: string;
	beatIds: string[];
}

export interface StoryIndexDocument {
	schemaVersion: 2;
	volumes: StoryIndexVolume[];
	/** 作者声明全书未完待续（`open_ended: true`）：最后一个 Beat 不是结局。 */
	openEnded: boolean;
}

export type BeatStateValue = string | boolean;

export interface BeatStateChanges {
	world: Record<string, BeatStateValue>;
	reader: Record<string, BeatStateValue>;
	character: Record<string, Record<string, BeatStateValue>>;
}

export interface StoryBeat {
	id: string;
	volumeId: string;
	title?: string;
	refs: string[];
	/** Derived from compiled hard-state changes; never rendered or persisted as authored refs. */
	stateRefs: string[];
	contracts: {
		open: string[];
		advance: string[];
		resolve: string[];
	};
	changes: BeatStateChanges;
	text: string;
	path: string;
	ordinal: number;
}

export interface StoryVolume {
	id: string;
	title: string;
	/** index.yaml 中声明的 Beat 顺序；解析失败的 Beat 不在 beats 中，但仍在这里。 */
	beatIds: string[];
	beats: StoryBeat[];
}

export interface StoryOutline {
	volumes: StoryVolume[];
	beats: StoryBeat[];
}

export function storyBeatRoutingRefs(beat: StoryBeat): string[] {
	return [...new Set([...beat.refs, ...beat.stateRefs])];
}

function record(input: unknown, label: string): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new BookParseError("invalid_document", `${label} 必须是键值映射`);
	}
	return input as Record<string, unknown>;
}

export function parseStoryIndexYaml(input: unknown): StoryIndexDocument {
	checkedBookSchema(StoryIndexYamlSchema, input, "outline/story/index.yaml");
	const raw = record(input, "outline/story/index.yaml");
	const volumes = (raw.volumes as Record<string, unknown>[]).map((entry) => ({
		id: entry.id as string,
		title: entry.title as string,
		beatIds: [...(entry.beat_ids as string[])],
	}));
	const volumeIds = volumes.map((volume) => volume.id);
	if (volumeIds.length !== new Set(volumeIds).size) {
		throw new BookParseError("invalid_document", "story index 里的卷 id 有重复");
	}
	const beatIds = volumes.flatMap((volume) => volume.beatIds);
	if (beatIds.length !== new Set(beatIds).size) {
		throw new BookParseError("invalid_document", "story index 里的 StoryBeat id 有重复");
	}
	return { schemaVersion: 2, volumes, openEnded: raw.open_ended === true };
}

export function parseStoryBeat(volumeId: string, beatId: string, path: string, markdown: string): StoryBeat {
	if (!VOLUME_ID.test(volumeId)) throw new BookParseError("invalid_document", `卷 id 不合法：${volumeId}`);
	if (!STORY_BEAT_ID.test(beatId)) throw new BookParseError("invalid_document", `StoryBeat id 不合法：${beatId}`);
	const document = parseMarkdownDocument(markdown, path);
	checkedBookSchema(StoryBeatHeaderSchema, document.frontmatter, `${path} frontmatter`, {
		path,
		pointerPrefix: "/frontmatter",
	});
	if (document.body.length === 0) {
		throw new BookParseError("invalid_story_outline", `${path} 的 StoryBeat 正文不能为空`, [
			{ path, pointer: "/body", message: "StoryBeat 的正文不能为空" },
		]);
	}
	const title = document.frontmatter.title as string | undefined;
	const refs = flattenReferenceGroups((document.frontmatter.refs as ReferenceGroups | undefined) ?? {});
	const contractOperations = (document.frontmatter.contracts as Record<string, string[]> | undefined) ?? {};
	const rawChanges =
		(document.frontmatter.changes as
			| {
					world?: Record<string, BeatStateValue>;
					reader?: Record<string, BeatStateValue>;
					character?: Record<string, Record<string, BeatStateValue>>;
			  }
			| undefined) ?? {};
	const changes: BeatStateChanges = {
		world: { ...(rawChanges.world ?? {}) },
		reader: { ...(rawChanges.reader ?? {}) },
		character: Object.fromEntries(
			Object.entries(rawChanges.character ?? {}).map(([id, assignments]) => [id, { ...assignments }]),
		),
	};
	if (
		document.frontmatter.changes !== undefined &&
		Object.keys(changes.world).length === 0 &&
		Object.keys(changes.reader).length === 0 &&
		Object.values(changes.character).every((assignments) => Object.keys(assignments).length === 0)
	) {
		throw new BookParseError("invalid_document", `${path} 的 changes 里至少要有一项赋值`, [
			{ path, pointer: "/frontmatter/changes", message: "这个 Beat 没有硬状态变化时，不要写 changes" },
		]);
	}
	const emptyCharacter = Object.entries(changes.character).find(
		([, assignments]) => Object.keys(assignments).length === 0,
	);
	if (emptyCharacter !== undefined) {
		throw new BookParseError("invalid_document", `${path} 有一个空的人物变化`, [
			{
				path,
				pointer: `/frontmatter/changes/character/${emptyCharacter[0]}`,
				message: "这个人物没有硬状态变化时，不要写它的 scope",
			},
		]);
	}
	for (const [index, ref] of refs.entries()) {
		if (ref !== ref.normalize("NFC")) {
			throw new BookParseError("invalid_document", `${path} ref must use Unicode NFC normalization`, [
				{
					path,
					pointer: groupedReferencePointer("refs", refs, index),
					message: "reference must use Unicode NFC normalization",
				},
			]);
		}
	}
	for (const operation of ["open", "advance", "resolve"] as const) {
		for (const [index, id] of (contractOperations[operation] ?? []).entries()) {
			if (id !== id.normalize("NFC")) {
				throw new BookParseError(
					"invalid_document",
					`${path} StoryContract id must use Unicode NFC normalization`,
					[
						{
							path,
							pointer: `/frontmatter/contracts/${operation}/${index}`,
							message: "StoryContract id must use Unicode NFC normalization",
						},
					],
				);
			}
		}
	}
	return {
		id: beatId,
		volumeId,
		...(title === undefined ? {} : { title }),
		refs,
		stateRefs: [],
		contracts: {
			open: [...(contractOperations.open ?? [])],
			advance: [...(contractOperations.advance ?? [])],
			resolve: [...(contractOperations.resolve ?? [])],
		},
		changes,
		text: document.body,
		path,
		ordinal: -1,
	};
}

export function bindStoryOutline(
	index: StoryIndexDocument,
	files: readonly { volumeId: string; beatId: string; path: string; markdown: string }[],
	collector: DiagnosticCollector,
): StoryOutline {
	const byKey = new Map(files.map((file) => [`${file.volumeId}/${file.beatId}`, file]));
	if (byKey.size !== files.length) {
		collector.report("invalid_story_outline", [{ message: "story beat file paths must be unique" }]);
	}
	const expected = new Set(index.volumes.flatMap((volume) => volume.beatIds.map((id) => `${volume.id}/${id}`)));
	for (const file of files) {
		if (expected.has(`${file.volumeId}/${file.beatId}`)) continue;
		collector.report("invalid_story_outline", [
			{
				path: file.path,
				message: `StoryBeat 没有列在 outline/story/index.yaml 里`,
				hint: `把 ${file.beatId} 加进卷 ${file.volumeId}，或者删掉这个文件`,
			},
		]);
	}
	const volumes = index.volumes.map(
		(volume): StoryVolume => ({
			id: volume.id,
			title: volume.title,
			beatIds: [...volume.beatIds],
			beats: volume.beatIds.flatMap((beatId) => {
				const file = byKey.get(`${volume.id}/${beatId}`);
				if (file === undefined) {
					collector.report("invalid_story_outline", [
						{
							path: "outline/story/index.yaml",
							message: `index 里列了但文件不存在：${volume.id}/${beatId}`,
							hint: `创建 outline/story/${volume.id}/${beatId}.md，或者把这个 id 从 index 里删掉`,
						},
					]);
					return [];
				}
				const beat = collector.collect(() => parseStoryBeat(volume.id, beatId, file.path, file.markdown));
				return beat === undefined ? [] : [beat];
			}),
		}),
	);
	const hasStory = volumes.some((volume) => volume.beats.length > 0);
	for (const volume of volumes) {
		if (!hasStory || volume.beats.length > 0 || volume.beatIds.length > 0) continue;
		collector.report("invalid_story_outline", [
			{
				path: "outline/story/index.yaml",
				message: `卷 ${volume.id} 至少要有一个 StoryBeat`,
			},
		]);
	}
	const beats = volumes.flatMap((volume) => volume.beats);
	beats.forEach((beat, ordinal) => {
		beat.ordinal = ordinal;
	});
	const story: StoryOutline = { volumes, beats };
	validateStoryDependencies(story, collector);
	return story;
}
