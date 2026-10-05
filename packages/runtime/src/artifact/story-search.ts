import { compareCodeUnits, sha256Buffer } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { compareArtifactIdentities, copyArtifactIdentity, sameArtifactNamespace } from "../artifact/identity.js";
import type { ArtifactCandidate, ArtifactIdentity, ArtifactNamespace, CandidateArtifact } from "../artifact/types.js";

/** 检索结果的出处。候选（checkout）上的检索也用它的基线版本，没有第二种 basis。 */
export type StorySearchBasis = { kind: "project_revision"; projectRevisionId: string };

export interface StorySearchRequest {
	query: string;
	namespace?: ArtifactNamespace;
	kinds?: readonly string[];
	limit?: number;
}

export interface StorySearchTextRange {
	start: number;
	end: number;
}

export interface StorySearchHit {
	identity: ArtifactIdentity;
	path: string;
	contentSha256: string;
	match: "content" | "identity";
	matchedTerms: string[];
	range?: StorySearchTextRange;
	score: number;
}

export interface StorySearchResult {
	basis: StorySearchBasis;
	query: string;
	hits: StorySearchHit[];
}

interface Match {
	matchedTerms: string[];
	range?: StorySearchTextRange;
	score: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function queryTerms(query: string): string[] {
	const normalized = query.trim().toLowerCase();
	if (normalized.length === 0) throw new ArtifactError("invalid_story_search", "Story Search query must not be empty");
	const terms = new Set<string>([normalized]);
	for (const segment of normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? []) {
		if (segment.length >= 2) terms.add(segment);
		if (/^[\p{Script=Han}]+$/u.test(segment) && Array.from(segment).length > 2) {
			const codePoints = Array.from(segment);
			for (let index = 0; index < codePoints.length - 1; index += 1) {
				terms.add(`${codePoints[index]}${codePoints[index + 1]}`);
			}
		}
	}
	return [...terms].sort(
		(left, right) => Array.from(right).length - Array.from(left).length || compareCodeUnits(left, right),
	);
}

function text(artifact: CandidateArtifact): string | undefined {
	if (
		!artifact.mediaType.startsWith("text/") &&
		!artifact.mediaType.startsWith("application/yaml") &&
		!artifact.mediaType.startsWith("application/json")
	) {
		return undefined;
	}
	try {
		return decoder.decode(artifact.bytes);
	} catch {
		return undefined;
	}
}

function codePointRange(content: string, index: number, term: string): StorySearchTextRange {
	const start = Array.from(content.slice(0, index)).length;
	return { start, end: start + Array.from(term).length };
}

function matchArtifact(artifact: CandidateArtifact, path: string, terms: readonly string[]): Match | undefined {
	const content = text(artifact);
	const normalizedContent = content?.toLowerCase();
	const identityText = `${path}\n${artifact.identity.kind}\n${artifact.identity.localId}`.toLowerCase();
	const contentTerms: string[] = [];
	const identityTerms: string[] = [];
	let bestContentIndex = -1;
	let bestContentTerm = "";

	for (const term of terms) {
		const contentIndex = normalizedContent?.indexOf(term) ?? -1;
		if (contentIndex >= 0) {
			contentTerms.push(term);
			if (bestContentIndex < 0 || term.length > bestContentTerm.length) {
				bestContentIndex = contentIndex;
				bestContentTerm = term;
			}
		}
		if (identityText.includes(term)) identityTerms.push(term);
	}
	if (contentTerms.length === 0 && identityTerms.length === 0) return undefined;

	const exact = terms[0] as string;
	const exactContent = normalizedContent?.includes(exact) ?? false;
	const score =
		(exactContent ? 1000 : 0) +
		(identityText.includes(exact) ? 500 : 0) +
		contentTerms.reduce((total, term) => total + Array.from(term).length * 10, 0) +
		identityTerms.reduce((total, term) => total + Array.from(term).length * 5, 0);
	return {
		matchedTerms: [...new Set([...contentTerms, ...identityTerms])],
		...(bestContentIndex < 0 || content === undefined
			? {}
			: { range: codePointRange(content, bestContentIndex, bestContentTerm) }),
		score,
	};
}

function validateLimit(limit: number | undefined): number {
	if (limit === undefined) return 10;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new ArtifactError("invalid_story_search", "Story Search limit must be an integer from 1 to 100");
	}
	return limit;
}

/**
 * 查一份 Source 时只查它的抽取：原文、原始字节与描述是输入不是抽取，按字找原文另走 `findInMaterial`
 * （`search_source`）。2026-10-05 之前这条只写在 Agent 的 search 工具里，`suim search --source` 会落到原文上。
 */
const SOURCE_INPUT_KINDS = new Set(["source-material", "source-input", "source-descriptor"]);

export function searchStoryCandidate(
	candidate: ArtifactCandidate,
	basis: StorySearchBasis,
	request: StorySearchRequest,
): StorySearchResult {
	const query = request.query.trim();
	const terms = queryTerms(query);
	const kinds = request.kinds === undefined ? undefined : new Set(request.kinds);
	const extractionOnly = request.namespace?.kind === "source" && kinds === undefined;
	const hits = candidate.artifacts
		.filter(
			(artifact) =>
				(request.namespace === undefined ||
					sameArtifactNamespace(artifact.identity.namespace, request.namespace)) &&
				(kinds === undefined || kinds.has(artifact.identity.kind)) &&
				!(extractionOnly && SOURCE_INPUT_KINDS.has(artifact.identity.kind)),
		)
		.flatMap((artifact): StorySearchHit[] => {
			const path = artifact.path;
			const match = matchArtifact(artifact, path, terms);
			if (match === undefined) return [];
			return [
				{
					identity: copyArtifactIdentity(artifact.identity),
					path,
					contentSha256: sha256Buffer(artifact.bytes),
					match: match.range === undefined ? "identity" : "content",
					matchedTerms: match.matchedTerms,
					...(match.range === undefined ? {} : { range: match.range }),
					score: match.score,
				},
			];
		})
		.sort((left, right) => right.score - left.score || compareArtifactIdentities(left.identity, right.identity))
		.slice(0, validateLimit(request.limit));
	return { basis, query, hits };
}
