import { randomUUID } from "node:crypto";
import { sha256Buffer } from "@suiming/story";
import { applyChangeOperations } from "./change-operations.js";
import { ArtifactError } from "./errors.js";
import {
	artifactIdentityKey,
	compareArtifactIdentities,
	copyArtifactIdentity,
	formatArtifactIdentity,
} from "./identity.js";
import type {
	ArtifactCandidate,
	ArtifactCandidateValidator,
	ArtifactContent,
	ArtifactVersion,
	CandidateArtifact,
	ChangeSet,
	ProjectRevision,
	RevisionArtifact,
} from "./types.js";
import { artifactVersionId } from "./version-storage.js";

export interface CreateProjectOptions {
	/** 由部署 store 指定的 revision id，让 session 内的基线 revision 与 Project head 同名；缺省随机。 */
	revisionId?: string;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function requireMediaType(mediaType: string): void {
	if (mediaType.trim().length === 0) {
		throw new ArtifactError("invalid_media_type", "Artifact mediaType must not be empty");
	}
}

/**
 * 进程内的 Artifact store：runtime session 在一个 ProjectRevision 上的工作集。
 * version id 与 SQLite / Cloud 一样是内容寻址（`av_` + mediaType 与内容 hash），
 * 同样内容在任何 store 里都是同一个 version；revision id 没有独立序列，
 * 基线 revision 沿用部署 store 的 id，新 revision 用随机 id（ADR-0009 决定 4）。
 */
/** store 内部的版本记录：`ProjectRevision` 只剩位置，逐 artifact 清单留在这里。 */
interface StoredRevision {
	id: string;
	parentId: string | null;
	artifacts: (RevisionArtifact & { path: string })[];
}

export class InMemoryArtifactStore {
	readonly #versions = new Map<string, ArtifactVersion>();
	readonly #revisions = new Map<string, StoredRevision>();
	readonly #projectByRevisionId = new Map<string, string>();
	readonly #projectHeads = new Map<string, string>();

	createProject(
		projectId: string,
		artifacts: readonly CandidateArtifact[],
		validate: ArtifactCandidateValidator,
		options: CreateProjectOptions = {},
	): ProjectRevision {
		if (this.#projectHeads.has(projectId)) {
			throw new ArtifactError("project_already_exists", `Project already exists: ${projectId}`);
		}
		const identities = new Set<string>();
		const candidate: CandidateArtifact[] = artifacts.map((artifact) => {
			const key = artifactIdentityKey(artifact.identity);
			if (identities.has(key)) {
				throw new ArtifactError(
					"duplicate_artifact_identity",
					`Duplicate artifact identity: ${formatArtifactIdentity(artifact.identity)}`,
				);
			}
			identities.add(key);
			requireMediaType(artifact.mediaType);
			return {
				identity: copyArtifactIdentity(artifact.identity),
				path: artifact.path,
				mediaType: artifact.mediaType,
				bytes: copyBytes(artifact.bytes),
			};
		});
		validate({ baseRevisionId: "genesis", artifacts: candidate });
		const revisionId = options.revisionId ?? `pr_${randomUUID()}`;
		if (this.#revisions.has(revisionId)) {
			throw new ArtifactError("revision_conflict", `ProjectRevision already exists: ${revisionId}`);
		}
		const revision = this.#persistRevision(projectId, revisionId, null, candidate);
		this.#projectHeads.set(projectId, revision.id);
		return revision;
	}

	headRevisionId(projectId: string): string {
		const revisionId = this.#projectHeads.get(projectId);
		if (revisionId === undefined) throw new ArtifactError("project_not_found", `Project not found: ${projectId}`);
		return revisionId;
	}

	readRevision(revisionId: string): ProjectRevision {
		const revision = this.#requireRevision(revisionId);
		return { id: revision.id, parentId: revision.parentId };
	}

	/** 版本里的逐 artifact 清单。只有 Cloud 的 store 需要它（`readVersion` 的归属校验）。 */
	readRevisionArtifacts(revisionId: string): RevisionArtifact[] {
		return this.#requireRevision(revisionId).artifacts.map((artifact) => ({
			identity: copyArtifactIdentity(artifact.identity),
			artifactVersionId: artifact.artifactVersionId,
		}));
	}

	readProjectRevision(projectId: string, revisionId: string): ProjectRevision {
		if (this.#projectByRevisionId.get(revisionId) !== projectId) {
			throw new ArtifactError(
				"revision_project_mismatch",
				`ProjectRevision ${revisionId} does not belong to ${projectId}`,
			);
		}
		return this.readRevision(revisionId);
	}

	readVersion(id: string): ArtifactVersion {
		const version = this.#versions.get(id);
		if (version === undefined) {
			throw new ArtifactError("artifact_version_not_found", `Artifact version not found: ${id}`);
		}
		return { id: version.id, mediaType: version.mediaType, bytes: copyBytes(version.bytes) };
	}

	snapshot(revisionId: string): ArtifactCandidate {
		const revision = this.#requireRevision(revisionId);
		return {
			baseRevisionId: revision.id,
			artifacts: revision.artifacts.map((artifact) => {
				const version = this.readVersion(artifact.artifactVersionId);
				return {
					identity: copyArtifactIdentity(artifact.identity),
					path: artifact.path,
					mediaType: version.mediaType,
					bytes: version.bytes,
				};
			}),
		};
	}

	snapshotForProject(projectId: string, revisionId: string): ArtifactCandidate {
		this.readProjectRevision(projectId, revisionId);
		return this.snapshot(revisionId);
	}

	/** 把 ChangeSet 应用到当前 head：候选经 validate 后成为新 revision；应用本身是纯函数。 */
	commit(projectId: string, changeSet: ChangeSet, validate: ArtifactCandidateValidator): ProjectRevision {
		const headRevisionId = this.headRevisionId(projectId);
		if (headRevisionId !== changeSet.baseRevisionId) {
			throw new ArtifactError(
				"revision_conflict",
				`Project head is ${headRevisionId}; ChangeSet is based on ${changeSet.baseRevisionId}`,
			);
		}
		const next = applyChangeOperations(this.snapshot(headRevisionId).artifacts, changeSet.operations);
		validate({ baseRevisionId: headRevisionId, artifacts: next });
		const revision = this.#persistRevision(projectId, `pr_${randomUUID()}`, headRevisionId, next);
		this.#projectHeads.set(projectId, revision.id);
		return revision;
	}

	#persistRevision(
		projectId: string,
		revisionId: string,
		parentId: string | null,
		artifacts: readonly CandidateArtifact[],
	): ProjectRevision {
		const revision: StoredRevision = {
			id: revisionId,
			parentId,
			artifacts: artifacts
				.map((artifact) => ({
					identity: copyArtifactIdentity(artifact.identity),
					path: artifact.path,
					artifactVersionId: this.#persistVersion(artifact).id,
				}))
				.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
		};
		this.#revisions.set(revisionId, revision);
		this.#projectByRevisionId.set(revisionId, projectId);
		return this.readRevision(revisionId);
	}

	#requireRevision(revisionId: string): StoredRevision {
		const revision = this.#revisions.get(revisionId);
		if (revision === undefined) throw new ArtifactError("revision_not_found", `Revision not found: ${revisionId}`);
		return revision;
	}

	#persistVersion(content: ArtifactContent): ArtifactVersion {
		requireMediaType(content.mediaType);
		const id = artifactVersionId(content.mediaType, sha256Buffer(content.bytes));
		const existing = this.#versions.get(id);
		if (existing !== undefined) return existing;
		const version: ArtifactVersion = { id, mediaType: content.mediaType, bytes: copyBytes(content.bytes) };
		this.#versions.set(id, version);
		return version;
	}
}
