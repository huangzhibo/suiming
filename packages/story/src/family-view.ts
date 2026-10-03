import { SuimError } from "./errors.js";
import type { CharacterEntry, FamilyLinkKind } from "./parse-book.js";

export interface FamilyProjectionLink {
	subjectCharacterId: string;
	kind: FamilyLinkKind;
	relatedCharacterId: string;
	role?: string;
	sourcePath: string;
}

export interface CharacterFamilyProjection {
	subjectCharacterId: string;
	characterIds: string[];
	links: FamilyProjectionLink[];
}

function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function projectCharacterFamily(
	characters: readonly CharacterEntry[],
	subjectCharacterId: string,
): CharacterFamilyProjection {
	const byId = new Map(characters.map((character) => [character.id, character]));
	if (!byId.has(subjectCharacterId)) {
		throw new SuimError("character_not_found", `Character not found: ${subjectCharacterId}`);
	}
	const allLinks = characters.flatMap((character) =>
		character.family.map(
			(link): FamilyProjectionLink => ({
				subjectCharacterId: character.id,
				kind: link.kind,
				relatedCharacterId: link.character,
				...(link.role === undefined ? {} : { role: link.role }),
				sourcePath: character.path,
			}),
		),
	);
	const adjacent = new Map<string, Set<string>>();
	for (const link of allLinks) {
		if (!byId.has(link.relatedCharacterId)) {
			throw new SuimError(
				"missing_context_reference",
				`Character not found for family link: ${link.relatedCharacterId}`,
			);
		}
		const subjectNeighbors = adjacent.get(link.subjectCharacterId) ?? new Set<string>();
		subjectNeighbors.add(link.relatedCharacterId);
		adjacent.set(link.subjectCharacterId, subjectNeighbors);
		const relatedNeighbors = adjacent.get(link.relatedCharacterId) ?? new Set<string>();
		relatedNeighbors.add(link.subjectCharacterId);
		adjacent.set(link.relatedCharacterId, relatedNeighbors);
	}
	const selected = new Set([subjectCharacterId]);
	const queue = [subjectCharacterId];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) continue;
		for (const related of adjacent.get(current) ?? []) {
			if (selected.has(related)) continue;
			selected.add(related);
			queue.push(related);
		}
	}
	return {
		subjectCharacterId,
		characterIds: [...selected].sort(compare),
		links: allLinks
			.filter((link) => selected.has(link.subjectCharacterId) && selected.has(link.relatedCharacterId))
			.sort((left, right) =>
				compare(
					`${left.subjectCharacterId}:${left.kind}:${left.relatedCharacterId}`,
					`${right.subjectCharacterId}:${right.kind}:${right.relatedCharacterId}`,
				),
			),
	};
}
