export const STORY_REFERENCE_KINDS = ["character", "place", "resource", "secret", "world", "beat"] as const;

export type StoryReferenceKind = (typeof STORY_REFERENCE_KINDS)[number];
export type ReferenceGroups = Partial<Record<StoryReferenceKind, string[]>>;

export function flattenReferenceGroups(groups: ReferenceGroups): string[] {
	return STORY_REFERENCE_KINDS.flatMap((kind) => (groups[kind] ?? []).map((id) => `${kind}:${id}`));
}

export function groupedReferencePointer(field: "refs" | "subjects", refs: readonly string[], index: number): string {
	const reference = refs[index] ?? "";
	const separator = reference.indexOf(":");
	const kind = separator < 0 ? "unknown" : reference.slice(0, separator);
	const groupIndex = refs.slice(0, index).filter((candidate) => candidate.startsWith(`${kind}:`)).length;
	return `/frontmatter/${field}/${kind}/${groupIndex}`;
}
