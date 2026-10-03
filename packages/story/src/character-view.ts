import { type CharacterEntry, identityRef } from "./parse-book.js";
import { type StoryOutline, storyBeatRoutingRefs } from "./story-outline.js";

export interface CharacterStoryProjection {
	characterId: string;
	name: string;
	referencedStoryBeatIds: string[];
	unboundNameCandidateStoryBeatIds: string[];
	reviewStoryBeatIds: string[];
}

export function projectCharacterStory(story: StoryOutline, character: CharacterEntry): CharacterStoryProjection {
	const referencedIds = new Set(
		story.beats
			.filter((beat) => storyBeatRoutingRefs(beat).includes(identityRef("character", character.id)))
			.map((beat) => beat.id),
	);
	const name = character.name;
	const recallNames = [...new Set([name, ...character.aliases])];
	const unboundCandidateIds = new Set(
		recallNames.length === 0
			? []
			: story.beats
					.filter(
						(beat) =>
							!referencedIds.has(beat.id) &&
							recallNames.some((name) => beat.title?.includes(name) === true || beat.text.includes(name)),
					)
					.map((beat) => beat.id),
	);
	const reviewBeats = story.beats.filter((beat) => referencedIds.has(beat.id) || unboundCandidateIds.has(beat.id));
	return {
		characterId: character.id,
		name,
		referencedStoryBeatIds: reviewBeats.filter((beat) => referencedIds.has(beat.id)).map((beat) => beat.id),
		unboundNameCandidateStoryBeatIds: reviewBeats
			.filter((beat) => unboundCandidateIds.has(beat.id))
			.map((beat) => beat.id),
		reviewStoryBeatIds: reviewBeats.map((beat) => beat.id),
	};
}

/**
 * Restrict Character recall to evidence that appears before one StoryBeat.
 * This is an evidence boundary, not a complete or deterministic Character state.
 */
export function projectCharacterEvidenceBefore(
	story: StoryOutline,
	character: CharacterEntry,
	beforeOrdinal: number,
): CharacterStoryProjection {
	const projection = projectCharacterStory(story, character);
	const ordinals = new Map(story.beats.map((beat) => [beat.id, beat.ordinal]));
	const isEarlier = (id: string): boolean => (ordinals.get(id) ?? Number.POSITIVE_INFINITY) < beforeOrdinal;
	const referencedStoryBeatIds = projection.referencedStoryBeatIds.filter(isEarlier);
	const unboundNameCandidateStoryBeatIds = projection.unboundNameCandidateStoryBeatIds.filter(isEarlier);
	const reviewStoryBeatIds = projection.reviewStoryBeatIds.filter(isEarlier);
	return {
		...projection,
		referencedStoryBeatIds,
		unboundNameCandidateStoryBeatIds,
		reviewStoryBeatIds,
	};
}
