import {
	evaluate,
	projectCharacterEvidenceBefore,
	projectCharacterFamily,
	projectCharacterStory,
	type StateAssignment,
} from "@suiming/story";
import { DESIGN_FRAME_FULL_RENDER_CODE_POINTS, designFrame, frameSelections } from "../artifact/design-frame.js";
import { ArtifactError } from "../artifact/errors.js";
import { inspectStoryDesignCandidate } from "../artifact/story-design-validator.js";
import type { StoryImpactSubject } from "../artifact/story-impact.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import type { ArtifactCandidate, ArtifactIdentity } from "../artifact/types.js";
import { compileStoryStateContext, type StoryStateTask } from "./story-state-context.js";

/**
 * Design 的派生视图 Context（ADR-0009 决定 10：人物视角等视图与 Context Compiler 共用同一投影）：
 * - `design:character:<id>[:at:<beat-id>]`：一个人物的家族、硬状态、出场 Beat，`at` 把证据边界收到该 Beat 开始前，
 *   用于人物过去时点模拟；
 * - `design:family:<id>`：一个人物的家族网与成员文件；
 * - `design:volume:<id>`：一卷的 Beat 顺序、Contract 动作与整卷 Design。
 * 视图只是确定性投影，不是新的 artifact；文本里的 Design 由 Frame 载入，超预算的 Beat 进目录。
 */
export type DesignViewTask =
	| StoryStateTask
	| { kind: "character"; id: string; atStoryBeatId?: string }
	| { kind: "family"; id: string }
	| { kind: "volume"; id: string };

export interface CompiledDesignView {
	text: string;
	artifacts: ContextSelection[];
	view: {
		kind: DesignViewTask["kind"];
		id: string;
		atStoryBeatId?: string;
		phase?: StoryStateTask["phase"];
		subject?: StoryStateTask["subject"];
		storyBeatIds: string[];
	};
}

type ContextSelection = { identity: ArtifactIdentity; range?: { start: number; end: number } };

const decoder = new TextDecoder();

function identityKey(identity: ArtifactIdentity): string {
	return JSON.stringify(identity);
}

function characterIdentity(id: string): ArtifactIdentity {
	return { namespace: { kind: "target" }, kind: "character", localId: id };
}

function renderArtifact(candidate: ArtifactCandidate, identity: ArtifactIdentity): string | undefined {
	const artifact = candidate.artifacts.find((item) => identityKey(item.identity) === identityKey(identity));
	if (artifact === undefined) return undefined;
	const path = storyPackageCodec.pathForIdentity(identity, candidate);
	return `--- BEGIN ARTIFACT "${path}" ---\n${decoder.decode(artifact.bytes).trimEnd()}\n--- END ARTIFACT "${path}" ---`;
}

function mergeSelections(...groups: readonly (readonly ContextSelection[])[]): ContextSelection[] {
	const seen = new Set<string>();
	const merged: ContextSelection[] = [];
	for (const group of groups) {
		for (const selection of group) {
			const key = identityKey(selection.identity);
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(selection);
		}
	}
	return merged;
}

function renderAssignment(assignment: StateAssignment): string {
	return `- ${assignment.subject}.${assignment.property} = ${String(assignment.value)}${
		assignment.scope === "world" ? "" : `（${assignment.scope} 视角）`
	}`;
}

export function compileDesignViewContext(candidate: ArtifactCandidate, task: DesignViewTask): CompiledDesignView {
	if (task.kind === "state") return compileStoryStateContext(candidate, task);
	const design = inspectStoryDesignCandidate(candidate).design;
	const story = design.story;
	const ordinalOf = new Map(story.beats.map((beat) => [beat.id, beat.ordinal]));
	const titleOf = (id: string): string => {
		const beat = story.beats.find((item) => item.id === id);
		return beat?.title === undefined ? id : `${id} — ${beat.title}`;
	};

	if (task.kind === "volume") {
		const volume = story.volumes.find((item) => item.id === task.id);
		if (volume === undefined) throw new ArtifactError("story_volume_not_found", `Story volume not found: ${task.id}`);
		const beats = story.beats.filter((beat) => beat.volumeId === volume.id);
		const seeds: StoryImpactSubject[] = beats.map((beat) => ({ kind: "beat", id: beat.id }));
		const frame = designFrame(candidate, { seeds });
		const lines = beats.map((beat) => {
			const actions = [
				...beat.contracts.open.map((id) => `open ${id}`),
				...beat.contracts.advance.map((id) => `advance ${id}`),
				...beat.contracts.resolve.map((id) => `resolve ${id}`),
			];
			return `- ${titleOf(beat.id)}${actions.length === 0 ? "" : `（${actions.join("，")}）`}`;
		});
		return {
			text: [
				`# 卷视角：${volume.title}（${volume.id}），${beats.length} 个 Beat`,
				"## Beat 顺序与 Contract 动作",
				lines.join("\n") || "（本卷还没有 Beat）",
				"## Design",
				frame.text,
			].join("\n\n"),
			artifacts: frameSelections(frame, candidate),
			view: { kind: "volume", id: volume.id, storyBeatIds: beats.map((beat) => beat.id) },
		};
	}

	const character = design.characters.find((item) => item.id === task.id);
	if (character === undefined) throw new ArtifactError("character_not_found", `Character not found: ${task.id}`);
	const family = projectCharacterFamily(design.characters, character.id);
	const familyLines = family.links.map(
		(link) =>
			`- ${link.subjectCharacterId} 的 ${link.kind}：${link.relatedCharacterId}${link.role === undefined ? "" : `（${link.role}）`}`,
	);

	if (task.kind === "family") {
		const members = family.characterIds;
		const memberTexts = members
			.map((id) => renderArtifact(candidate, characterIdentity(id)))
			.filter((text): text is string => text !== undefined);
		const seeds: StoryImpactSubject[] = members.map((id) => ({ kind: "character", id }));
		const frame = designFrame(candidate, { seeds, extraBeatCodePoints: DESIGN_FRAME_FULL_RENDER_CODE_POINTS });
		const memberBeatIds = new Set(
			members.flatMap((id) => projectCharacterStory(story, characterOf(design, id)).reviewStoryBeatIds),
		);
		const storyBeatIds = story.beats.filter((beat) => memberBeatIds.has(beat.id)).map((beat) => beat.id);
		return {
			text: [
				`# 家族视角：${character.name}（character:${character.id}），成员 ${members.join("、")}`,
				"## 家族声明",
				familyLines.join("\n") || "（没有家族声明）",
				"## 成员文件",
				memberTexts.join("\n\n"),
				"## Design",
				frame.text,
			].join("\n\n"),
			artifacts: mergeSelections(
				members.map((id) => ({ identity: characterIdentity(id) })),
				frameSelections(frame, candidate),
			),
			view: { kind: "family", id: character.id, storyBeatIds },
		};
	}

	let beforeOrdinal: number | undefined;
	if (task.atStoryBeatId !== undefined) {
		beforeOrdinal = ordinalOf.get(task.atStoryBeatId);
		if (beforeOrdinal === undefined) {
			throw new ArtifactError("story_beat_not_found", `StoryBeat not found: ${task.atStoryBeatId}`);
		}
	}
	const limit = beforeOrdinal;
	const projection =
		limit === undefined
			? projectCharacterStory(story, character)
			: projectCharacterEvidenceBefore(story, character, limit);
	const excluded = new Set(
		limit === undefined ? [] : story.beats.filter((beat) => beat.ordinal >= limit).map((beat) => beat.id),
	);
	const state = evaluate({
		...design.stateProjection,
		changes: design.stateProjection.changes.filter((change) => !excluded.has(change.storyBeatId)),
		authorizedBeatIds: story.beats.filter((beat) => !excluded.has(beat.id)).map((beat) => beat.id),
	});
	const subject = `character:${character.id}`;
	const own = state.finalState.filter((assignment) => assignment.subject === subject);
	// holder 的值是带种类前缀的引用（character:<id>），与主体写法一致。
	const held = state.finalState.filter(
		(assignment) => assignment.property === "holder" && assignment.value === subject,
	);
	const stateLines = [
		...own.map(renderAssignment),
		...held.map((assignment) => `- 持有 ${assignment.subject}`),
		...(state.passed ? [] : ["- （硬状态重放有失败，见 suim --json check）"]),
	];
	const beatEntries = [
		...projection.referencedStoryBeatIds.map((id) => ({ id, note: "" })),
		...projection.unboundNameCandidateStoryBeatIds.map((id) => ({ id, note: " · 只出现名字，refs 未登记" })),
	].sort((left, right) => (ordinalOf.get(left.id) ?? 0) - (ordinalOf.get(right.id) ?? 0));
	const beatLines = beatEntries.map((entry) => `- ${titleOf(entry.id)}${entry.note}`);
	const frame = designFrame(candidate, {
		seeds: [{ kind: "character", id: character.id }],
		extraBeatCodePoints: DESIGN_FRAME_FULL_RENDER_CODE_POINTS,
		...(limit === undefined ? {} : { fullRenderCodePoints: 0, excludeStoryBeatIds: excluded }),
	});
	const heading =
		limit === undefined
			? `# 人物视角：${character.name}（character:${character.id}）`
			: `# 人物视角：${character.name}（character:${character.id}），时点：${task.atStoryBeatId} 开始前；之后的 Beat 不作为证据`;
	return {
		text: [
			heading,
			"## 家族",
			familyLines.join("\n") || "（没有家族声明）",
			limit === undefined ? "## 硬状态（全书末）" : "## 硬状态（时点前重放）",
			stateLines.join("\n") || "（没有硬状态声明）",
			"## 出场 Beat（按故事顺序）",
			beatLines.join("\n") || "（没有出场 Beat）",
			"## Design",
			frame.text,
		].join("\n\n"),
		artifacts: mergeSelections([{ identity: characterIdentity(character.id) }], frameSelections(frame, candidate)),
		view: {
			kind: "character",
			id: character.id,
			...(task.atStoryBeatId === undefined ? {} : { atStoryBeatId: task.atStoryBeatId }),
			storyBeatIds: projection.reviewStoryBeatIds,
		},
	};
}

function characterOf(design: ReturnType<typeof inspectStoryDesignCandidate>["design"], id: string) {
	const character = design.characters.find((item) => item.id === id);
	if (character === undefined) throw new ArtifactError("character_not_found", `Character not found: ${id}`);
	return character;
}
