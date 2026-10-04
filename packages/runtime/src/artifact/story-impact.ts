import {
	type BoundDesign,
	type CreativeIntent,
	projectCharacterFamily,
	type StoryBeat,
	storyDependentClosure,
} from "@suiming/story";
import { ArtifactError } from "./errors.js";
import { sourceArtifactIdentity, targetArtifactIdentity } from "./identity.js";
import { sourceExtractionDesign } from "./source-validator.js";
import { inspectStoryDesignCandidate } from "./story-design-validator.js";
import { storyPackageCodec } from "./story-package-codec.js";
import type { ArtifactCandidate } from "./types.js";

export const STORY_IMPACT_SUBJECT_KINDS = [
	"beat",
	"character",
	"place",
	"resource",
	"world",
	"contract",
	"intent",
] as const;
export type StoryImpactSubjectKind = (typeof STORY_IMPACT_SUBJECT_KINDS)[number];

export interface StoryImpactSubject {
	kind: StoryImpactSubjectKind;
	id: string;
}

/**
 * 修改某个 Design 主体时可能受影响的候选集合（K 步的 Frame 查询，旧仓 `design impact` 的等价物）。
 * 只做召回：告诉作者或 host agent 该去读哪些文件，不判断语义，也不是编辑的前置门。
 */
export interface StoryImpact {
	subject: StoryImpactSubject;
	/** 直接涉及主体的 Beat，按故事顺序。 */
	storyBeatIds: string[];
	/**
	 * 经 refs.beat 依赖上面这些 Beat 的下游 Beat（不含它们本身），按故事顺序。对紧挨着的上一节的依赖只算一跳、
	 * 不往后传；主体是 Beat 时，紧接着的下一节总在其中。
	 */
	dependentStoryBeatIds: string[];
	characterIds: string[];
	placeIds: string[];
	resourceIds: string[];
	worldIds: string[];
	contractIds: string[];
	intentIds: string[];
	/** 以上全部候选的逻辑路径，供逐个读取。 */
	paths: string[];
}

export function parseStoryImpactSubject(value: string): StoryImpactSubject {
	const separator = value.indexOf(":");
	const kind = separator === -1 ? "" : value.slice(0, separator);
	const id = separator === -1 ? "" : value.slice(separator + 1);
	if (!(STORY_IMPACT_SUBJECT_KINDS as readonly string[]).includes(kind) || id.length === 0) {
		throw new ArtifactError(
			"invalid_impact_subject",
			`Impact subject must be <kind>:<id> with kind in ${STORY_IMPACT_SUBJECT_KINDS.join(" / ")}, received ${value}`,
		);
	}
	return { kind: kind as StoryImpactSubjectKind, id };
}

function refIds(beat: StoryBeat, kind: string): string[] {
	const prefix = `${kind}:`;
	return [...beat.refs, ...beat.stateRefs]
		.filter((ref) => ref.startsWith(prefix))
		.map((ref) => ref.slice(prefix.length));
}

function beatsReferencing(design: BoundDesign, ref: string): StoryBeat[] {
	return design.story.beats.filter((beat) => beat.refs.includes(ref) || beat.stateRefs.includes(ref));
}

function intentCoversBeat(intent: CreativeIntent, beat: StoryBeat, ordinals: ReadonlyMap<string, number>): boolean {
	if (intent.target.kind === "book") return true;
	const from = ordinals.get(intent.target.fromStoryBeatId);
	const to = ordinals.get(intent.target.toStoryBeatId);
	return from !== undefined && to !== undefined && beat.ordinal >= from && beat.ordinal <= to;
}

function rootBeats(design: BoundDesign, subject: StoryImpactSubject): { roots: StoryBeat[]; familyIds: string[] } {
	const { story } = design;
	switch (subject.kind) {
		case "beat": {
			const beat = story.beats.find((item) => item.id === subject.id);
			if (beat === undefined) throw new ArtifactError("story_beat_not_found", `StoryBeat not found: ${subject.id}`);
			return { roots: [beat], familyIds: [] };
		}
		case "character": {
			const family = projectCharacterFamily(design.characters, subject.id).characterIds;
			const ids = new Set([subject.id, ...family]);
			return {
				roots: story.beats.filter((beat) => refIds(beat, "character").some((id) => ids.has(id))),
				familyIds: [...ids].sort(),
			};
		}
		case "place":
		case "resource": {
			const entries = subject.kind === "place" ? design.places : design.resources;
			if (!entries.some((entry) => entry.id === subject.id)) {
				throw new ArtifactError(`${subject.kind}_not_found`, `${subject.kind} not found: ${subject.id}`);
			}
			return { roots: beatsReferencing(design, `${subject.kind}:${subject.id}`), familyIds: [] };
		}
		case "world": {
			if (!design.world.some((entry) => entry.id === subject.id)) {
				throw new ArtifactError("world_not_found", `World document not found: ${subject.id}`);
			}
			return {
				roots: subject.id === "core" ? [...story.beats] : beatsReferencing(design, `world:${subject.id}`),
				familyIds: [],
			};
		}
		case "contract": {
			const contract = design.contracts.find((entry) => entry.id === subject.id);
			if (contract === undefined)
				throw new ArtifactError("contract_not_found", `StoryContract not found: ${subject.id}`);
			const deadline = contract.deadline.kind === "story_beat" ? contract.deadline.storyBeatId : undefined;
			return {
				roots: story.beats.filter(
					(beat) =>
						beat.id === deadline ||
						beat.contracts.open.includes(subject.id) ||
						beat.contracts.advance.includes(subject.id) ||
						beat.contracts.resolve.includes(subject.id),
				),
				familyIds: [],
			};
		}
		case "intent": {
			const intent = design.intents.find((entry) => entry.id === subject.id);
			if (intent === undefined) throw new ArtifactError("intent_not_found", `Intent not found: ${subject.id}`);
			const ordinals = new Map(story.beats.map((beat) => [beat.id, beat.ordinal]));
			return { roots: story.beats.filter((beat) => intentCoversBeat(intent, beat, ordinals)), familyIds: [] };
		}
	}
}

/** 缺省查 Target；给 sourceId 时查那份 Source 的抽取——同一套 Design 语义，召回规则一样，只是路径在 source/<id>/ 下。 */
export function storyImpact(candidate: ArtifactCandidate, subject: StoryImpactSubject, sourceId?: string): StoryImpact {
	const design =
		sourceId === undefined
			? inspectStoryDesignCandidate(candidate).design
			: sourceExtractionDesign(candidate, sourceId);
	const { roots, familyIds } = rootBeats(design, subject);
	const rootIds = new Set(roots.map((beat) => beat.id));
	const dependents = storyDependentClosure(design.story, [...rootIds]).filter((beat) => !rootIds.has(beat.id));
	// 改的是一节时，紧接着的下一节要接上它的结尾：顺序上的接缝，不论有没有声明 refs.beat，只算一跳。
	const next =
		subject.kind === "beat"
			? design.story.beats.find((beat) => beat.ordinal === (roots[0]?.ordinal ?? -2) + 1)
			: undefined;
	if (next !== undefined && !rootIds.has(next.id) && !dependents.includes(next)) dependents.push(next);
	const involved = [...roots, ...dependents];
	const byOrdinal = (left: StoryBeat, right: StoryBeat) => left.ordinal - right.ordinal;
	const subjectRef = `${subject.kind}:${subject.id}`;
	const ordinals = new Map(design.story.beats.map((beat) => [beat.id, beat.ordinal]));

	const characterIds = new Set(familyIds);
	const placeIds = new Set<string>();
	const resourceIds = new Set<string>();
	const worldIds = new Set<string>();
	const contractIds = new Set<string>();
	const intentIds = new Set<string>();
	for (const beat of involved) {
		for (const id of refIds(beat, "character")) characterIds.add(id);
		for (const id of refIds(beat, "place")) placeIds.add(id);
		for (const id of refIds(beat, "resource")) resourceIds.add(id);
		for (const id of refIds(beat, "world")) worldIds.add(id);
		for (const id of [...beat.contracts.open, ...beat.contracts.advance, ...beat.contracts.resolve])
			contractIds.add(id);
	}
	for (const contract of design.contracts) if (contract.subjects.includes(subjectRef)) contractIds.add(contract.id);
	for (const intent of design.intents) {
		if (intent.subjects.includes(subjectRef) || roots.some((beat) => intentCoversBeat(intent, beat, ordinals))) {
			intentIds.add(intent.id);
		}
	}
	if (subject.kind === "character") characterIds.add(subject.id);
	if (subject.kind === "place") placeIds.add(subject.id);
	if (subject.kind === "resource") resourceIds.add(subject.id);
	if (subject.kind === "world") worldIds.add(subject.id);
	if (subject.kind === "contract") contractIds.add(subject.id);
	if (subject.kind === "intent") intentIds.add(subject.id);

	const sortedIds = (ids: Set<string>) => [...ids].sort();
	const impact: Omit<StoryImpact, "paths"> = {
		subject,
		storyBeatIds: [...roots].sort(byOrdinal).map((beat) => beat.id),
		dependentStoryBeatIds: [...dependents].sort(byOrdinal).map((beat) => beat.id),
		characterIds: sortedIds(characterIds),
		placeIds: sortedIds(placeIds),
		resourceIds: sortedIds(resourceIds),
		worldIds: sortedIds(worldIds).filter((id) => design.world.some((entry) => entry.id === id)),
		contractIds: sortedIds(contractIds),
		intentIds: sortedIds(intentIds),
	};
	const path = (kind: string, localId: string): string | undefined => {
		try {
			const identity =
				sourceId === undefined
					? targetArtifactIdentity(kind, localId)
					: sourceArtifactIdentity(sourceId, kind, localId);
			return storyPackageCodec.pathForIdentity(identity, candidate);
		} catch {
			return undefined;
		}
	};
	const paths = [
		...impact.storyBeatIds.map((id) => path("story-beat", id)),
		...impact.dependentStoryBeatIds.map((id) => path("story-beat", id)),
		...impact.characterIds.map((id) => path("character", id)),
		...impact.placeIds.map((id) => path("place", id)),
		...impact.resourceIds.map((id) => path("resource", id)),
		...impact.worldIds.map((id) => path("world", id)),
		...impact.contractIds.map((id) => path("story-contract", id)),
		...impact.intentIds.map((id) => path("intent", id)),
	].filter((item): item is string => item !== undefined);
	return { ...impact, paths: [...new Set(paths)] };
}
