import type { DiagnosticCollector } from "./collector.js";
import {
	isStateProperty,
	PROPERTY_SUBJECT_KINDS,
	PROPERTY_VALUE_KINDS,
	parseStateAssignment,
	referenceKind,
	STATE_PROPERTIES,
	type StateAssignment,
	type StateProjection,
	type StateProperty,
} from "./ir/index.js";
import type { CharacterEntry, IdentityEntry, PlaceEntry, ResourceEntry } from "./parse-book.js";
import type { BeatStateValue, StoryOutline } from "./story-outline.js";

interface StateIdentities {
	characters: readonly CharacterEntry[];
	places: readonly PlaceEntry[];
	resources: readonly ResourceEntry[];
}

interface IdentityCandidate {
	kind: "character" | "place" | "resource";
	id: string;
}

class StateProjectionCompileError extends Error {
	readonly pointer: string;

	constructor(pointer: string, message: string) {
		super(message);
		this.name = "StateProjectionCompileError";
		this.pointer = pointer;
	}
}

function pointerSegment(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function projectionError(pointer: string, error: unknown): StateProjectionCompileError {
	if (error instanceof StateProjectionCompileError) return error;
	return new StateProjectionCompileError(
		pointer,
		error instanceof Error ? error.message : "invalid hard-state projection",
	);
}

function identityIndex(identities: StateIdentities): Map<string, IdentityCandidate[]> {
	const index = new Map<string, IdentityCandidate[]>();
	for (const [kind, entries] of [
		["character", identities.characters],
		["place", identities.places],
		["resource", identities.resources],
	] as const) {
		for (const entry of entries) {
			const candidates = index.get(entry.id) ?? [];
			candidates.push({ kind, id: entry.id });
			index.set(entry.id, candidates);
		}
	}
	return index;
}

function splitStatePath(path: string): { subject: string; property: StateProperty } {
	for (const property of STATE_PROPERTIES) {
		const suffix = `.${property}`;
		if (path.endsWith(suffix) && path.length > suffix.length) {
			return { subject: path.slice(0, -suffix.length), property };
		}
	}
	throw new Error(`state path must end with .${STATE_PROPERTIES.join(" | .")}`);
}

function validateTypedIdentity(
	reference: string,
	allowedKinds: readonly string[],
	knownRefs: ReadonlySet<string>,
): string {
	const kind = referenceKind(reference);
	if (!allowedKinds.includes(kind)) {
		throw new Error(`expected ${allowedKinds.join(" or ")}, got ${kind}`);
	}
	if (kind !== "secret" && !knownRefs.has(reference)) {
		throw new Error(`missing identity ${reference}`);
	}
	return reference;
}

function resolveIdentity(
	value: string,
	allowedKinds: readonly string[],
	index: ReadonlyMap<string, IdentityCandidate[]>,
	knownRefs: ReadonlySet<string>,
): string {
	if (value.includes(":")) return validateTypedIdentity(value, allowedKinds, knownRefs);
	const allCandidates = index.get(value) ?? [];
	const candidates = allCandidates.filter((candidate) => allowedKinds.includes(candidate.kind));
	// secret 不对应文件，索引里永远没有它：属性已经说明只能是 secret（revealed），就按 secret 解析，
	// 声明过没有交给 Checker「先在 refs.secret 声明再揭示」那条规则，它带着怎么改的提示。
	if (
		candidates.length === 0 &&
		allCandidates.length === 0 &&
		allowedKinds.length === 1 &&
		allowedKinds[0] === "secret"
	)
		return `secret:${value}`;
	if (candidates.length === 0) {
		if (allCandidates.length > 0) {
			throw new Error(
				`${value} is ${[...new Set(allCandidates.map((candidate) => candidate.kind))].join("/")}; expected ${allowedKinds.join("/")}`,
			);
		}
		throw new Error(`missing ${allowedKinds.join("/")} identity ${value}`);
	}
	if (candidates.length > 1) throw new Error(`ambiguous identity ${value}; use kind:${value}`);
	const candidate = candidates[0];
	if (candidate === undefined) throw new Error(`missing identity ${value}`);
	return `${candidate.kind}:${candidate.id}`;
}

function compileValue(
	rawValue: BeatStateValue,
	property: StateProperty,
	index: ReadonlyMap<string, IdentityCandidate[]>,
	knownRefs: ReadonlySet<string>,
): string | boolean {
	const valueKind = PROPERTY_VALUE_KINDS[property];
	if (valueKind !== undefined && typeof rawValue === "string" && rawValue !== "none") {
		return resolveIdentity(rawValue, [valueKind], index, knownRefs);
	}
	return rawValue;
}

function compileAssignments(
	entries: Readonly<Record<string, BeatStateValue>>,
	scope: string,
	index: ReadonlyMap<string, IdentityCandidate[]>,
	knownRefs: ReadonlySet<string>,
	pointerPrefix: string,
): StateAssignment[] {
	const assignments: StateAssignment[] = [];
	const seen = new Map<string, StateAssignment>();
	for (const [path, rawValue] of Object.entries(entries)) {
		try {
			const { subject: rawSubject, property } = splitStatePath(path);
			const subject = resolveIdentity(rawSubject, PROPERTY_SUBJECT_KINDS[property], index, knownRefs);
			const value = compileValue(rawValue, property, index, knownRefs);
			const assignment = parseStateAssignment({ subject, property, value, scope });
			const key = `${assignment.scope}\u0000${assignment.subject}\u0000${assignment.property}`;
			const previous = seen.get(key);
			if (previous !== undefined && previous.value !== assignment.value) {
				throw new Error(`${path} conflicts with another spelling of the same state property`);
			}
			seen.set(key, assignment);
			assignments.push(assignment);
		} catch (error) {
			throw projectionError(`${pointerPrefix}/${pointerSegment(path)}`, error);
		}
	}
	return assignments;
}

function compileInitial(
	entry: IdentityEntry,
	kind: IdentityCandidate["kind"],
	index: ReadonlyMap<string, IdentityCandidate[]>,
	knownRefs: ReadonlySet<string>,
): StateAssignment[] {
	const assignments: StateAssignment[] = [];
	for (const [rawProperty, rawValue] of Object.entries(entry.initial)) {
		try {
			if (!isStateProperty(rawProperty)) {
				throw new Error(`initial property must be ${STATE_PROPERTIES.join(" | ")}, got ${rawProperty}`);
			}
			if (!PROPERTY_SUBJECT_KINDS[rawProperty].includes(kind)) {
				throw new Error(`${rawProperty} does not apply to ${kind}`);
			}
			assignments.push(
				parseStateAssignment({
					subject: `${kind}:${entry.id}`,
					property: rawProperty,
					value: compileValue(rawValue, rawProperty, index, knownRefs),
					scope: "world",
				}),
			);
		} catch (error) {
			throw projectionError(`/frontmatter/initial/${pointerSegment(rawProperty)}`, error);
		}
	}
	return assignments;
}

function assignmentRefs(assignment: StateAssignment): string[] {
	const refs = [assignment.subject];
	if (typeof assignment.value === "string" && assignment.value !== "none" && assignment.value.includes(":")) {
		refs.push(assignment.value);
	}
	if (assignment.scope.startsWith("character:")) refs.push(assignment.scope);
	return refs;
}

export function compileStateProjection(
	story: StoryOutline,
	identities: StateIdentities,
	collector: DiagnosticCollector,
): StateProjection {
	const index = identityIndex(identities);
	const knownRefs = new Set(
		[...index.values()].flatMap((entries) => entries.map((entry) => `${entry.kind}:${entry.id}`)),
	);
	const initial: StateAssignment[] = [];
	for (const [kind, entries] of [
		["character", identities.characters],
		["place", identities.places],
		["resource", identities.resources],
	] as const) {
		for (const entry of entries) {
			try {
				initial.push(...compileInitial(entry, kind, index, knownRefs));
			} catch (error) {
				const message = error instanceof Error ? error.message : "invalid initial hard state";
				collector.report("invalid_document", [
					{
						path: entry.path,
						pointer: error instanceof StateProjectionCompileError ? error.pointer : "/frontmatter/initial",
						message,
					},
				]);
			}
		}
	}

	const changes: StateProjection["changes"][number][] = [];
	for (const beat of story.beats) {
		try {
			const assignments = [
				...compileAssignments(beat.changes.world, "world", index, knownRefs, "/frontmatter/changes/world"),
				...compileAssignments(beat.changes.reader, "reader", index, knownRefs, "/frontmatter/changes/reader"),
				...Object.entries(beat.changes.character).flatMap(([characterId, values]) => {
					const pointer = `/frontmatter/changes/character/${pointerSegment(characterId)}`;
					try {
						const scope = resolveIdentity(characterId, ["character"], index, knownRefs);
						return compileAssignments(values, scope, index, knownRefs, pointer);
					} catch (error) {
						throw projectionError(pointer, error);
					}
				}),
			];
			beat.stateRefs = [...new Set(assignments.flatMap(assignmentRefs))];
			if (assignments.length > 0) changes.push({ storyBeatId: beat.id, assignments });
		} catch (error) {
			const message = error instanceof Error ? error.message : "invalid hard-state change";
			collector.report("invalid_document", [
				{
					path: beat.path,
					pointer: error instanceof StateProjectionCompileError ? error.pointer : "/frontmatter/changes",
					message,
				},
			]);
		}
	}

	return {
		profileVersion: "state-projection-p0@2",
		initial,
		changes,
		authorizedBeatIds: story.beats.map((beat) => beat.id),
	};
}
