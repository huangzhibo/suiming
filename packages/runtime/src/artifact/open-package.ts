import { ArtifactError } from "./errors.js";
import { artifactIdentityKey, copyArtifactIdentity, formatArtifactIdentity } from "./identity.js";
import type { CreateProjectOptions, InMemoryArtifactStore } from "./memory-store.js";
import type {
	ArtifactCandidate,
	ArtifactCandidateValidator,
	ArtifactIdentity,
	CandidateArtifact,
	ProjectRevision,
} from "./types.js";

export interface OpenPackageFile {
	path: string;
	mediaType: string;
	bytes: Uint8Array;
}

export interface ArtifactPathCodec {
	identityForPath(path: string): ArtifactIdentity;
	pathForIdentity(identity: ArtifactIdentity, candidate: ArtifactCandidate): string;
}

export function validateOpenPackagePath(path: string): void {
	if (
		path.length === 0 ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new ArtifactError("invalid_logical_path", `Invalid open-package path: ${path}`);
	}
}

export function importOpenPackage(
	store: InMemoryArtifactStore,
	projectId: string,
	files: readonly OpenPackageFile[],
	codec: ArtifactPathCodec,
	validate: ArtifactCandidateValidator,
	options: CreateProjectOptions = {},
): ProjectRevision {
	const paths = new Set<string>();
	const identities = new Set<string>();
	const artifacts: CandidateArtifact[] = files.map((file) => {
		validateOpenPackagePath(file.path);
		if (paths.has(file.path)) throw new ArtifactError("duplicate_logical_path", `Duplicate path: ${file.path}`);
		paths.add(file.path);
		const identity = codec.identityForPath(file.path);
		const key = artifactIdentityKey(identity);
		if (identities.has(key)) {
			throw new ArtifactError(
				"duplicate_artifact_identity",
				`Multiple paths map to ${formatArtifactIdentity(identity)}`,
			);
		}
		identities.add(key);
		return {
			identity: copyArtifactIdentity(identity),
			path: file.path,
			mediaType: file.mediaType,
			bytes: new Uint8Array(file.bytes),
		};
	});
	// 路径是包里写着的事实，不再拿 index 重新投影一遍再比对自己：文件与 index 对不上是 Checker 的题目。
	return store.createProject(projectId, artifacts, validate, options);
}

export function exportOpenPackage(
	store: InMemoryArtifactStore,
	projectId: string,
	revisionId: string,
): OpenPackageFile[] {
	const candidate = store.snapshotForProject(projectId, revisionId);
	const files = candidate.artifacts.map((artifact) => ({
		path: artifact.path,
		mediaType: artifact.mediaType,
		bytes: new Uint8Array(artifact.bytes),
	}));
	const paths = files.map((file) => file.path);
	if (new Set(paths).size !== paths.length) {
		throw new ArtifactError("duplicate_logical_path", "Multiple artifacts share the same path");
	}
	return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
