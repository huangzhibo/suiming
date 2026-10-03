import { sha256Buffer } from "@suiming/story";
import { artifactIdentityKey, copyArtifactIdentity } from "./identity.js";
import type { OpenPackageFile } from "./open-package.js";
import { classifyOpenStoryDirectoryFile } from "./open-story-directory.js";
import { validateOpenStoryFiles } from "./open-story-validation.js";
import { validateStoryProjectCandidate } from "./story-design-validator.js";
import { storyPackageCodec } from "./story-package-codec.js";
import type { ArtifactCandidate, CandidateArtifact, ChangeOperation } from "./types.js";

export function candidateFromOpenStoryFiles(
	files: readonly OpenPackageFile[],
	baseRevisionId: string,
): ArtifactCandidate {
	validateOpenStoryFiles(files);
	const artifacts = files
		.filter((file) => classifyOpenStoryDirectoryFile(file.path) === "story")
		.map(
			(file): CandidateArtifact => ({
				identity: storyPackageCodec.identityForPath(file.path),
				path: file.path,
				mediaType: file.mediaType,
				bytes: new Uint8Array(file.bytes),
			}),
		);
	const candidate = { baseRevisionId, artifacts };
	validateStoryProjectCandidate(candidate);
	return candidate;
}

export function openStoryFilesFromCandidate(candidate: ArtifactCandidate): OpenPackageFile[] {
	const files = candidate.artifacts
		.map((artifact) => ({
			path: artifact.path,
			mediaType: artifact.mediaType,
			bytes: new Uint8Array(artifact.bytes),
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
	validateOpenStoryFiles(files);
	return files;
}

export function changeOperationsBetweenCandidates(base: ArtifactCandidate, next: ArtifactCandidate): ChangeOperation[] {
	const baseByIdentity = new Map(base.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]));
	const nextByIdentity = new Map(next.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]));
	const operations: ChangeOperation[] = [];
	for (const key of [...new Set([...baseByIdentity.keys(), ...nextByIdentity.keys()])].sort()) {
		const before = baseByIdentity.get(key);
		const after = nextByIdentity.get(key);
		if (before === undefined && after !== undefined) {
			operations.push({
				operation: "create",
				identity: copyArtifactIdentity(after.identity),
				path: after.path,
				mediaType: after.mediaType,
				bytes: new Uint8Array(after.bytes),
			});
		} else if (before !== undefined && after === undefined) {
			operations.push({ operation: "delete", identity: copyArtifactIdentity(before.identity) });
		} else if (
			before !== undefined &&
			after !== undefined &&
			(before.path !== after.path ||
				before.mediaType !== after.mediaType ||
				sha256Buffer(before.bytes) !== sha256Buffer(after.bytes))
		) {
			operations.push({
				operation: "replace",
				identity: copyArtifactIdentity(after.identity),
				path: after.path,
				mediaType: after.mediaType,
				bytes: new Uint8Array(after.bytes),
			});
		}
	}
	return operations;
}
