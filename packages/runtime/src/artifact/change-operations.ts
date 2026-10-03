import { sha256Buffer } from "@suiming/story";
import { ArtifactError } from "./errors.js";
import {
	artifactIdentityKey,
	compareArtifactIdentities,
	copyArtifactIdentity,
	formatArtifactIdentity,
} from "./identity.js";
import type { OpenPackageFile } from "./open-package.js";
import { classifyOpenStoryDirectoryFile } from "./open-story-directory.js";
import { storyPackageCodec } from "./story-package-codec.js";
import type { ArtifactCandidate, CandidateArtifact, ChangeOperation } from "./types.js";

function copyBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

/**
 * 把 Open Story Directory 的 story 文件投影成 ArtifactCandidate。非包路径被忽略。
 *
 * 文件放错卷目录不在这里拦：那是 Checker 的题目（story-outline 的 `invalid_story_outline`
 * 双向比对目录与 index，还给出「加进卷里或删掉文件」两条出路）。这里抛异常的话，一个还没写进
 * index 的新 Beat 文件会让 `status` / `diff` 与 turn 开场一起炸，而不是回到模型手里。
 */
export function candidateFromStoryFiles(
	baseRevisionId: string,
	files: readonly OpenPackageFile[],
	unrecognizedPaths: readonly string[] = [],
): ArtifactCandidate {
	const seen = new Map<string, string>();
	const artifacts = files
		.filter((file) => classifyOpenStoryDirectoryFile(file.path) === "story")
		.map((file): CandidateArtifact => {
			const identity = storyPackageCodec.identityForPath(file.path);
			const key = artifactIdentityKey(identity);
			const previous = seen.get(key);
			if (previous !== undefined) {
				throw new ArtifactError("duplicate_artifact_identity", `Both ${previous} and ${file.path} map to ${key}`);
			}
			seen.set(key, file.path);
			return { identity, path: file.path, mediaType: file.mediaType, bytes: copyBytes(file.bytes) };
		});
	return {
		baseRevisionId,
		artifacts,
		...(unrecognizedPaths.length === 0 ? {} : { unrecognizedPaths: [...unrecognizedPaths] }),
	};
}

/** 把 ChangeSet 操作应用到一组候选 artifact：纯函数，不触碰任何 store，返回按 identity 排序的新候选。 */
export function applyChangeOperations(
	base: readonly CandidateArtifact[],
	operations: readonly ChangeOperation[],
): CandidateArtifact[] {
	const candidate = new Map<string, CandidateArtifact>(
		base.map((artifact) => [
			artifactIdentityKey(artifact.identity),
			{
				identity: copyArtifactIdentity(artifact.identity),
				path: artifact.path,
				mediaType: artifact.mediaType,
				bytes: copyBytes(artifact.bytes),
			},
		]),
	);
	for (const operation of operations) {
		const key = artifactIdentityKey(operation.identity);
		if (operation.operation === "delete") {
			if (!candidate.delete(key)) {
				throw new ArtifactError(
					"artifact_not_found",
					`Artifact does not exist: ${formatArtifactIdentity(operation.identity)}`,
				);
			}
			continue;
		}
		if (operation.mediaType.trim().length === 0) {
			throw new ArtifactError("invalid_media_type", "Artifact mediaType must not be empty");
		}
		if (operation.operation === "create" && candidate.has(key)) {
			throw new ArtifactError(
				"artifact_already_exists",
				`Artifact already exists: ${formatArtifactIdentity(operation.identity)}`,
			);
		}
		if (operation.operation === "replace" && !candidate.has(key)) {
			throw new ArtifactError(
				"artifact_not_found",
				`Artifact does not exist: ${formatArtifactIdentity(operation.identity)}`,
			);
		}
		// path 与 identity 是同一个东西的两种写法，`identityForPath` 是不看 index 的纯解码，
		// 所以这条比对不是自证：它拦的是手写 ChangeSet 时路径拼错（release/manifest.yml 之类）。
		if (artifactIdentityKey(storyPackageCodec.identityForPath(operation.path)) !== key) {
			throw new ArtifactError(
				"path_identity_mismatch",
				`${operation.path} does not name ${formatArtifactIdentity(operation.identity)}`,
			);
		}
		candidate.set(key, {
			identity: copyArtifactIdentity(operation.identity),
			path: operation.path,
			mediaType: operation.mediaType,
			bytes: copyBytes(operation.bytes),
		});
	}
	return [...candidate.values()].sort((left, right) => compareArtifactIdentities(left.identity, right.identity));
}

/**
 * 两个候选之间的 ChangeSet 操作：以 identity 为键的 create / delete / replace，按键排序。
 * 路径变了也算 replace——Beat 换卷时内容可以一个字没改。
 */
export function changeOperationsBetween(base: ArtifactCandidate, next: ArtifactCandidate): ChangeOperation[] {
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
				bytes: copyBytes(after.bytes),
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
				bytes: copyBytes(after.bytes),
			});
		}
	}
	return operations;
}
