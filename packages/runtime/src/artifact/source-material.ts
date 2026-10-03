import { ArtifactError } from "../artifact/errors.js";
import { artifactIdentityKey, isSourceArtifactIdentity, sourceArtifactIdentity } from "../artifact/identity.js";
import type { ArtifactCandidate, CandidateArtifact } from "../artifact/types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface SourceMaterialView {
	artifact: CandidateArtifact;
	text: string;
}

/**
 * 只找原文，不校验这个 Source 的抽取与笔记：抽取写到一半有格式错误时，读原文、查覆盖率仍要能用，错误由 check 报。
 * 2026-10-02 之前这里先 inspect 整个 Source，Design 里一处写错，读原文就跟着失败。
 */
export function sourceMaterialFromCandidate(candidate: ArtifactCandidate, sourceId: string): SourceMaterialView {
	if (!candidate.artifacts.some((item) => isSourceArtifactIdentity(item.identity, sourceId)))
		throw new ArtifactError("source_not_found", `Source not found: ${sourceId}`);
	const key = artifactIdentityKey(sourceArtifactIdentity(sourceId, "source-material", "main"));
	const artifact = candidate.artifacts.find((item) => artifactIdentityKey(item.identity) === key);
	if (artifact === undefined)
		throw new ArtifactError("source_artifact_missing", `Source ${sourceId} is missing material`);
	try {
		return { artifact, text: decoder.decode(artifact.bytes) };
	} catch {
		throw new ArtifactError("invalid_utf8", `Source ${sourceId} material must be UTF-8`);
	}
}
