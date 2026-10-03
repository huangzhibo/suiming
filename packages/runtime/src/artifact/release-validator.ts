import { parseReleaseManifest, parseYaml, sha256Buffer } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { isTargetArtifactIdentity } from "../artifact/identity.js";
import type { ArtifactCandidate, CandidateArtifact } from "../artifact/types.js";

function utf8(artifact: CandidateArtifact, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
	} catch {
		throw new ArtifactError("invalid_utf8", `${label} must contain UTF-8 text`);
	}
}

export function validateReleaseArtifactsCandidate(candidate: ArtifactCandidate): void {
	const artifacts = candidate.artifacts.filter(
		(artifact) =>
			isTargetArtifactIdentity(artifact.identity) &&
			["release-manifest", "release-chapter"].includes(artifact.identity.kind),
	);
	if (artifacts.length === 0) return;
	const manifests = artifacts.filter((artifact) => artifact.identity.kind === "release-manifest");
	if (manifests.length !== 1 || manifests[0]?.identity.localId !== "main") {
		throw new ArtifactError("invalid_release", "Release must contain exactly one release/manifest.yaml");
	}
	const manifestArtifact = manifests[0];
	if (manifestArtifact === undefined) throw new ArtifactError("invalid_release", "Release manifest is missing");
	const manifest = parseReleaseManifest(
		parseYaml(utf8(manifestArtifact, "release/manifest.yaml"), "release/manifest.yaml"),
	);
	const chapters = artifacts.filter((artifact) => artifact.identity.kind === "release-chapter");
	const byId = new Map(chapters.map((artifact) => [artifact.identity.localId, artifact]));
	if (byId.size !== chapters.length || chapters.length !== manifest.chapters.length) {
		throw new ArtifactError("invalid_release", "Release chapter set does not match its manifest");
	}
	for (const chapter of manifest.chapters) {
		const artifact = byId.get(chapter.id);
		if (artifact === undefined) {
			throw new ArtifactError("invalid_release", `Release chapter is missing: ${chapter.path}`);
		}
		const content = utf8(artifact, chapter.path);
		if (Array.from(content).length !== chapter.codePoints || sha256Buffer(artifact.bytes) !== chapter.sha256) {
			throw new ArtifactError("invalid_release", `Release chapter content changed: ${chapter.path}`);
		}
	}
}
