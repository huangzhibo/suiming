import type { DiagnosticCollector } from "./collector.js";
import { groupedReferencePointer } from "./reference-groups.js";
import type { StoryBeat, StoryOutline } from "./story-outline.js";

const STORY_BEAT_REF_PREFIX = "beat:";

export interface StoryDependencyGraph {
	directDependenciesByBeatId: ReadonlyMap<string, readonly string[]>;
	directDependentsByBeatId: ReadonlyMap<string, readonly string[]>;
}

export function storyBeatIdFromRef(reference: string): string | undefined {
	return reference.startsWith(STORY_BEAT_REF_PREFIX) ? reference.slice(STORY_BEAT_REF_PREFIX.length) : undefined;
}

export function validateStoryDependencies(story: StoryOutline, collector: DiagnosticCollector): void {
	const byId = new Map(story.beats.map((beat) => [beat.id, beat]));
	for (const beat of story.beats) {
		for (const [index, reference] of beat.refs.entries()) {
			const dependencyId = storyBeatIdFromRef(reference);
			if (dependencyId === undefined) continue;
			const dependency = byId.get(dependencyId);
			if (dependency === undefined) {
				collector.report("story_dependency_not_found", [
					{
						path: beat.path,
						pointer: groupedReferencePointer("refs", beat.refs, index),
						message: `依赖的 StoryBeat 不存在：${dependencyId}`,
						actual: reference,
						hint: "改用 outline/story/index.yaml 里排在前面的 StoryBeat id。",
					},
				]);
				continue;
			}
			if (dependency.ordinal >= beat.ordinal) {
				collector.report("story_dependency_not_prior", [
					{
						path: beat.path,
						pointer: groupedReferencePointer("refs", beat.refs, index),
						message: "StoryBeat 只能依赖故事顺序里更早的 Beat",
						actual: reference,
						hint: "把共用的事实挪到更早的 Beat，或者删掉这条依赖。",
					},
				]);
			}
		}
	}
}

export function buildStoryDependencyGraph(story: StoryOutline): StoryDependencyGraph {
	const directDependenciesByBeatId = new Map<string, string[]>();
	const directDependentsByBeatId = new Map(story.beats.map((beat) => [beat.id, [] as string[]]));
	for (const beat of story.beats) {
		const dependencies = beat.refs.map(storyBeatIdFromRef).filter((id): id is string => id !== undefined);
		directDependenciesByBeatId.set(beat.id, dependencies);
		for (const dependencyId of dependencies) directDependentsByBeatId.get(dependencyId)?.push(beat.id);
	}
	return { directDependenciesByBeatId, directDependentsByBeatId };
}

function transitiveClosure(
	story: StoryOutline,
	rootIds: readonly string[],
	edges: ReadonlyMap<string, readonly string[]>,
): StoryBeat[] {
	const roots = new Set(rootIds);
	const seen = new Set<string>();
	const pending = [...rootIds];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) continue;
		for (const next of edges.get(current) ?? []) {
			if (roots.has(next) || seen.has(next)) continue;
			seen.add(next);
			pending.push(next);
		}
	}
	return story.beats.filter((beat) => seen.has(beat.id));
}

export function storyDependentClosure(story: StoryOutline, rootIds: readonly string[]): StoryBeat[] {
	return transitiveClosure(story, rootIds, buildStoryDependencyGraph(story).directDependentsByBeatId);
}
