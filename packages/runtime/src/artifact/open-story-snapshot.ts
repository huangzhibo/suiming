import { compareCodeUnits } from "@suiming/story";
import { ArtifactError } from "./errors.js";
import { artifactIdentityKey, formatArtifactIdentity } from "./identity.js";
import { type OpenPackageFile, validateOpenPackagePath } from "./open-package.js";
import { validateStoryProjectCandidate } from "./story-design-validator.js";
import { storyPackageCodec } from "./story-package-codec.js";
import type { ArtifactCandidate, CandidateArtifact } from "./types.js";

/**
 * 把一份完整的 Open Story snapshot 当作不可信输入解析成候选：路径合法且不重复、identity 不撞、mediaType 非空，
 * 再过一次 Checker。只收 story 包路径，仓库辅助文件由 codec 拒绝（`unsupported_story_package_path`）。
 */
export function candidateFromOpenStoryFiles(
	files: readonly OpenPackageFile[],
	baseRevisionId: string,
): ArtifactCandidate {
	const paths = new Set<string>();
	const identities = new Set<string>();
	const artifacts = files.map((file): CandidateArtifact => {
		validateOpenPackagePath(file.path);
		if (paths.has(file.path)) throw new ArtifactError("duplicate_logical_path", `Duplicate path: ${file.path}`);
		paths.add(file.path);
		const identity = storyPackageCodec.identityForPath(file.path);
		const key = artifactIdentityKey(identity);
		if (identities.has(key)) {
			throw new ArtifactError(
				"duplicate_artifact_identity",
				`Multiple paths map to ${formatArtifactIdentity(identity)}`,
			);
		}
		identities.add(key);
		if (file.mediaType.trim().length === 0) {
			throw new ArtifactError("invalid_media_type", "Artifact mediaType must not be empty");
		}
		return { identity, path: file.path, mediaType: file.mediaType, bytes: new Uint8Array(file.bytes) };
	});
	const candidate = { baseRevisionId, artifacts };
	validateStoryProjectCandidate(candidate);
	return candidate;
}

/** 已提交版本的候选投影成文件：版本在提交时过了 Checker，这里不再跑一遍；接收方按不可信输入重新解析。 */
export function openStoryFilesFromCandidate(candidate: ArtifactCandidate): OpenPackageFile[] {
	return (
		candidate.artifacts
			.map((artifact) => ({
				path: artifact.path,
				mediaType: artifact.mediaType,
				bytes: new Uint8Array(artifact.bytes),
			}))
			// 按 UTF-16 码元排，与 sdk 的包编码同一顺序；localeCompare 随运行环境的语言设置变，中文文件名的先后会不一样。
			.sort((left, right) => compareCodeUnits(left.path, right.path))
	);
}
