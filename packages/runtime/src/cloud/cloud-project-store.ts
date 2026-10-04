import { canonicalJson, sha256Buffer, sha256Hex } from "@suiming/story";
import type {
	ArtifactCandidate,
	ArtifactCandidateValidator,
	ArtifactIdentity,
	ArtifactVersion,
	CandidateArtifact,
	ChangeOperation,
	ChangeSet,
	ProjectRevision,
	RevisionArtifact,
} from "../artifact/types.js";
import { CloudStoreError } from "./errors.js";
import type { CloudProjectRole } from "./project-access.js";

export interface CloudProjectRecord {
	id: string;
	headRevisionId: string;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateCloudProjectInput {
	projectId: string;
	actorId: string;
	idempotencyKey: string;
	artifacts: readonly CandidateArtifact[];
}

export interface CommitCloudProjectInput {
	projectId: string;
	actorId: string;
	idempotencyKey: string;
	changeSet: ChangeSet;
}

export interface SetCloudProjectMemberInput {
	projectId: string;
	actorId: string;
	idempotencyKey: string;
	memberActorId: string;
	role: CloudProjectRole;
}

export interface ReadCloudProjectInput {
	projectId: string;
	actorId: string;
}

export interface ReadCloudProjectRevisionInput extends ReadCloudProjectInput {
	revisionId: string;
}

/**
 * Cloud 的版本：位置之外还带逐 artifact 清单。清单是 Cloud 自己的需要——它的对象存储按
 * `artifactVersionId` 取内容，`readVersion` 要判断某个 version 属不属于这个 Project。
 * 本地 Canon 是 git，tree 本身就是清单，所以 `ProjectRevision` 上没有这一层。
 */
export interface CloudProjectRevision extends ProjectRevision {
	artifacts: RevisionArtifact[];
}

export interface CloudProjectRevisionSnapshot {
	revision: CloudProjectRevision;
	candidate: ArtifactCandidate;
}

export interface CloudProjectStore {
	createProject(input: CreateCloudProjectInput, validate: ArtifactCandidateValidator): Promise<CloudProjectRevision>;
	commit(input: CommitCloudProjectInput, validate: ArtifactCandidateValidator): Promise<CloudProjectRevision>;
	setMember(input: SetCloudProjectMemberInput): Promise<CloudProjectRole>;
	project(input: ReadCloudProjectInput): Promise<CloudProjectRecord>;
	role(input: ReadCloudProjectInput): Promise<CloudProjectRole | undefined>;
	history(input: ReadCloudProjectInput): Promise<CloudProjectRevision[]>;
	readRevision(input: ReadCloudProjectRevisionInput): Promise<CloudProjectRevisionSnapshot>;
	readVersion(input: ReadCloudProjectInput & { artifactVersionId: string }): Promise<ArtifactVersion>;
}

export function normalizeCloudProjectStoreString(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_store_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function identityPayload(identity: ArtifactIdentity): Record<string, string> {
	return identity.namespace.kind === "target"
		? { namespace: "target", kind: identity.kind, localId: identity.localId }
		: {
				namespace: "source",
				sourceId: identity.namespace.sourceId,
				kind: identity.kind,
				localId: identity.localId,
			};
}

function contentPayload(content: { mediaType: string; bytes: Uint8Array }): {
	mediaType: string;
	contentSha256: string;
	byteLength: number;
} {
	return {
		mediaType: content.mediaType,
		contentSha256: sha256Buffer(content.bytes),
		byteLength: content.bytes.byteLength,
	};
}

export function cloudChangeOperationPayload(operation: ChangeOperation): unknown {
	if (operation.operation === "delete") {
		return { operation: "delete", identity: identityPayload(operation.identity) };
	}
	return {
		operation: operation.operation,
		identity: identityPayload(operation.identity),
		...contentPayload(operation),
	};
}

function artifactPayload(artifact: CandidateArtifact): unknown {
	return { identity: identityPayload(artifact.identity), ...contentPayload(artifact) };
}

export function cloudCreateProjectIdempotencyPayload(artifacts: readonly CandidateArtifact[]): unknown {
	return { artifacts: artifacts.map(artifactPayload) };
}

export function cloudCommitProjectIdempotencyPayload(changeSet: ChangeSet): unknown {
	return {
		baseRevisionId: changeSet.baseRevisionId,
		operations: changeSet.operations.map(cloudChangeOperationPayload),
	};
}

export function cloudSetProjectMemberIdempotencyPayload(memberActorId: string, role: CloudProjectRole): unknown {
	return { memberActorId, role };
}

/** 幂等回执的指纹：同一个 key 再来时比对输入。payload 由上面三个函数构造，大内容只取摘要。 */
export function cloudIdempotencyFingerprint(payload: unknown): string {
	try {
		return `sha256:${sha256Hex(canonicalJson(payload))}`;
	} catch (error) {
		throw new CloudStoreError(
			"invalid_cloud_store_input",
			`Idempotency payload must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
