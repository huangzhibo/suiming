import { canonicalJson, compareCodeUnits, sha256Buffer, sha256Hex } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { artifactIdentityKey, copyArtifactIdentity, formatArtifactIdentity } from "../artifact/identity.js";
import type { OpenPackageFile } from "../artifact/open-package.js";
import { classifyOpenStoryDirectoryFile } from "../artifact/open-story-directory.js";
import { validateOpenStoryFiles } from "../artifact/open-story-validation.js";
import { validateStoryProjectCandidate } from "../artifact/story-design-validator.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import type { ArtifactCandidate, ArtifactIdentity } from "../artifact/types.js";
import { CloudSyncError } from "./errors.js";

export interface OpenStorySyncFileState {
	path: string;
	mediaType: string;
	contentSha256: string;
	byteLength: number;
}

export interface OpenStorySyncDelta {
	key: string;
	kind: "story";
	change: "added" | "modified" | "deleted";
	before?: OpenStorySyncFileState;
	after?: OpenStorySyncFileState;
}

export interface OpenStorySyncConflict {
	key: string;
	kind: "story";
	description: string;
	base?: OpenStorySyncFileState;
	local?: OpenStorySyncFileState;
	cloud?: OpenStorySyncFileState;
}

export type MergeOpenStoryFilesResult =
	| {
			state: "merged";
			files: OpenPackageFile[];
			localChanges: OpenStorySyncDelta[];
			cloudChanges: OpenStorySyncDelta[];
	  }
	| {
			state: "conflict";
			conflicts: OpenStorySyncConflict[];
			localChanges: OpenStorySyncDelta[];
			cloudChanges: OpenStorySyncDelta[];
	  };

interface SyncEntry {
	key: string;
	kind: "story";
	identity?: ArtifactIdentity;
	file: OpenPackageFile;
	contentSha256: string;
}

function copyFile(file: OpenPackageFile): OpenPackageFile {
	return { path: file.path, mediaType: file.mediaType, bytes: new Uint8Array(file.bytes) };
}

/** 路径也算内容：Beat 换卷时字节一个没变，只有它所在的卷目录变了。 */
function sameEntry(left: SyncEntry | undefined, right: SyncEntry | undefined): boolean {
	return (
		(left === undefined && right === undefined) ||
		(left !== undefined &&
			right !== undefined &&
			left.file.path === right.file.path &&
			left.file.mediaType === right.file.mediaType &&
			left.contentSha256 === right.contentSha256)
	);
}

function fileState(entry: SyncEntry): OpenStorySyncFileState {
	return {
		path: entry.file.path,
		mediaType: entry.file.mediaType,
		contentSha256: entry.contentSha256,
		byteLength: entry.file.bytes.byteLength,
	};
}

function describe(entry: SyncEntry): string {
	return entry.identity === undefined ? entry.file.path : formatArtifactIdentity(entry.identity);
}

function entries(files: readonly OpenPackageFile[]): Map<string, SyncEntry> {
	validateOpenStoryFiles(files);
	const result = new Map<string, SyncEntry>();
	for (const source of files) {
		const file = copyFile(source);
		const kind = classifyOpenStoryDirectoryFile(file.path);
		if (kind !== "story") {
			throw new ArtifactError("unsupported_story_package_path", `Cannot synchronize ${file.path}`);
		}
		const identity = storyPackageCodec.identityForPath(file.path);
		const key = `story\0${artifactIdentityKey(identity)}`;
		if (result.has(key)) throw new ArtifactError("duplicate_artifact_identity", `Duplicate sync identity: ${key}`);
		result.set(key, {
			key,
			kind,
			identity: copyArtifactIdentity(identity),
			file,
			contentSha256: sha256Buffer(file.bytes),
		});
	}
	return result;
}

function delta(base: Map<string, SyncEntry>, next: Map<string, SyncEntry>): OpenStorySyncDelta[] {
	const result: OpenStorySyncDelta[] = [];
	for (const key of [...new Set([...base.keys(), ...next.keys()])].sort()) {
		const before = base.get(key);
		const after = next.get(key);
		if (sameEntry(before, after)) continue;
		const reference = after ?? (before as SyncEntry);
		result.push({
			key,
			kind: reference.kind,
			change: before === undefined ? "added" : after === undefined ? "deleted" : "modified",
			...(before === undefined ? {} : { before: fileState(before) }),
			...(after === undefined ? {} : { after: fileState(after) }),
		});
	}
	return result;
}

function materialize(entriesByKey: ReadonlyMap<string, SyncEntry>): OpenPackageFile[] {
	const storyEntries = [...entriesByKey.values()].filter((entry) => entry.kind === "story");
	const candidate: ArtifactCandidate = {
		baseRevisionId: "cloud-sync-merge",
		artifacts: storyEntries.map((entry) => ({
			identity: copyArtifactIdentity(entry.identity as ArtifactIdentity),
			path: entry.file.path,
			mediaType: entry.file.mediaType,
			bytes: new Uint8Array(entry.file.bytes),
		})),
	};
	const files = [
		...candidate.artifacts.map((artifact) => ({
			path: artifact.path,
			mediaType: artifact.mediaType,
			bytes: new Uint8Array(artifact.bytes),
		})),
	].sort((left, right) => compareCodeUnits(left.path, right.path));
	try {
		// Checker 也在这里：两侧各自合法、合起来不合法（一侧换卷、另一侧改了 index）是语义冲突，
		// 不是调用方传错了参数。以前拦这种情况的是 path_projection_mismatch，它随投影一起没了。
		validateStoryProjectCandidate(candidate);
		validateOpenStoryFiles(files);
	} catch (error) {
		throw new CloudSyncError(
			"cloud_sync_semantic_conflict",
			`Merged Local and Cloud changes do not form a valid Open Story snapshot: ${(error as Error).message}`,
		);
	}
	return files;
}

export function openStoryContentFingerprint(files: readonly OpenPackageFile[]): string {
	validateOpenStoryFiles(files);
	return `sha256:${sha256Hex(
		canonicalJson(
			[...files]
				.map((file) => ({
					path: file.path,
					mediaType: file.mediaType,
					contentSha256: sha256Buffer(file.bytes),
					byteLength: file.bytes.byteLength,
				}))
				.sort((left, right) => compareCodeUnits(left.path, right.path)),
		),
	)}`;
}

export function compareOpenStoryFiles(
	baseFiles: readonly OpenPackageFile[],
	nextFiles: readonly OpenPackageFile[],
): OpenStorySyncDelta[] {
	return delta(entries(baseFiles), entries(nextFiles));
}

export function mergeOpenStoryFiles(
	baseFiles: readonly OpenPackageFile[],
	localFiles: readonly OpenPackageFile[],
	cloudFiles: readonly OpenPackageFile[],
): MergeOpenStoryFilesResult {
	const base = entries(baseFiles);
	const local = entries(localFiles);
	const cloud = entries(cloudFiles);
	const localChanges = delta(base, local);
	const cloudChanges = delta(base, cloud);
	const merged = new Map<string, SyncEntry>();
	const conflicts: OpenStorySyncConflict[] = [];

	for (const key of [...new Set([...base.keys(), ...local.keys(), ...cloud.keys()])].sort()) {
		const baseEntry = base.get(key);
		const localEntry = local.get(key);
		const cloudEntry = cloud.get(key);
		const localChanged = !sameEntry(baseEntry, localEntry);
		const cloudChanged = !sameEntry(baseEntry, cloudEntry);
		if (localChanged && cloudChanged && !sameEntry(localEntry, cloudEntry)) {
			const reference = localEntry ?? cloudEntry ?? (baseEntry as SyncEntry);
			conflicts.push({
				key,
				kind: reference.kind,
				description: describe(reference),
				...(baseEntry === undefined ? {} : { base: fileState(baseEntry) }),
				...(localEntry === undefined ? {} : { local: fileState(localEntry) }),
				...(cloudEntry === undefined ? {} : { cloud: fileState(cloudEntry) }),
			});
			continue;
		}
		const selected = localChanged ? localEntry : cloudChanged ? cloudEntry : baseEntry;
		if (selected !== undefined) merged.set(key, selected);
	}

	if (conflicts.length > 0) return { state: "conflict", conflicts, localChanges, cloudChanges };
	return { state: "merged", files: materialize(merged), localChanges, cloudChanges };
}
