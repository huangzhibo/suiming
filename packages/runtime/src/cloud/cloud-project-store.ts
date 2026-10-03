import { sha256Buffer } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { compareArtifactIdentities, copyArtifactIdentity } from "../artifact/identity.js";
import { InMemoryArtifactStore } from "../artifact/memory-store.js";
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
import { type CloudIdempotencyStore, InMemoryCloudIdempotencyStore } from "./idempotency.js";
import { assertCloudProjectCapability, type CloudProjectRole } from "./project-access.js";

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

export interface InMemoryCloudProjectStoreOptions {
	now?: () => Date;
	idempotency?: CloudIdempotencyStore;
}

export function normalizeCloudProjectStoreString(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_store_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
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

function cloneProject(project: CloudProjectRecord): CloudProjectRecord {
	return { ...project };
}

function cloneRevision(revision: CloudProjectRevision): CloudProjectRevision {
	return {
		id: revision.id,
		parentId: revision.parentId,
		artifacts: revision.artifacts.map((artifact) => ({
			identity: copyArtifactIdentity(artifact.identity),
			artifactVersionId: artifact.artifactVersionId,
		})),
	};
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

export class InMemoryCloudProjectStore implements CloudProjectStore {
	readonly #artifacts = new InMemoryArtifactStore();
	readonly #projects = new Map<string, CloudProjectRecord>();
	readonly #members = new Map<string, Map<string, CloudProjectRole>>();
	readonly #idempotency: CloudIdempotencyStore;
	readonly #now: () => Date;

	constructor(options: InMemoryCloudProjectStoreOptions = {}) {
		this.#now = options.now ?? (() => new Date());
		this.#idempotency = options.idempotency ?? new InMemoryCloudIdempotencyStore({ now: this.#now });
	}

	async createProject(
		input: CreateCloudProjectInput,
		validate: ArtifactCandidateValidator,
	): Promise<CloudProjectRevision> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		return this.#idempotency.execute(
			{
				scope: { projectId, actorId, operation: "project.create" },
				idempotencyKey: input.idempotencyKey,
				payload: cloudCreateProjectIdempotencyPayload(input.artifacts),
			},
			() => {
				const timestamp = this.#timestamp();
				const revision = this.#artifacts.createProject(projectId, input.artifacts, validate);
				this.#projects.set(projectId, {
					id: projectId,
					headRevisionId: revision.id,
					createdBy: actorId,
					createdAt: timestamp,
					updatedAt: timestamp,
				});
				this.#members.set(projectId, new Map([[actorId, "owner"]]));
				return this.#cloudRevision(revision);
			},
		);
	}

	async commit(input: CommitCloudProjectInput, validate: ArtifactCandidateValidator): Promise<CloudProjectRevision> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		this.#authorize(projectId, actorId, "project.write");
		return this.#idempotency.execute(
			{
				scope: { projectId, actorId, operation: "revision.commit" },
				idempotencyKey: input.idempotencyKey,
				payload: cloudCommitProjectIdempotencyPayload(input.changeSet),
			},
			() => {
				const timestamp = this.#timestamp();
				const revision = this.#artifacts.commit(projectId, input.changeSet, validate);
				const project = this.#requireProject(projectId);
				project.headRevisionId = revision.id;
				project.updatedAt = timestamp;
				return this.#cloudRevision(revision);
			},
		);
	}

	async setMember(input: SetCloudProjectMemberInput): Promise<CloudProjectRole> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const memberActorId = normalizeCloudProjectStoreString(input.memberActorId, "project.memberActorId");
		this.#authorize(projectId, actorId, "project.manage");
		return this.#idempotency.execute(
			{
				scope: { projectId, actorId, operation: "project.member.set" },
				idempotencyKey: input.idempotencyKey,
				payload: cloudSetProjectMemberIdempotencyPayload(memberActorId, input.role),
			},
			() => {
				const timestamp = this.#timestamp();
				const members = this.#members.get(projectId) as Map<string, CloudProjectRole>;
				if (members.get(memberActorId) === "owner" && input.role !== "owner") {
					const ownerCount = [...members.values()].filter((role) => role === "owner").length;
					if (ownerCount === 1) {
						throw new CloudStoreError("cloud_last_owner", "A Cloud Project must retain at least one owner");
					}
				}
				members.set(memberActorId, input.role);
				this.#requireProject(projectId).updatedAt = timestamp;
				return input.role;
			},
		);
	}

	async project(input: ReadCloudProjectInput): Promise<CloudProjectRecord> {
		this.#authorize(input.projectId, input.actorId, "project.read");
		return cloneProject(this.#requireProject(input.projectId));
	}

	async role(input: ReadCloudProjectInput): Promise<CloudProjectRole | undefined> {
		return this.#members.get(input.projectId)?.get(input.actorId);
	}

	async history(input: ReadCloudProjectInput): Promise<CloudProjectRevision[]> {
		this.#authorize(input.projectId, input.actorId, "project.read");
		const project = this.#requireProject(input.projectId);
		const history: ProjectRevision[] = [];
		const visited = new Set<string>();
		let revisionId: string | null = project.headRevisionId;
		while (revisionId !== null) {
			if (visited.has(revisionId)) {
				throw new CloudStoreError("cloud_store_corrupt", `ProjectRevision history contains a cycle: ${revisionId}`);
			}
			visited.add(revisionId);
			const revision = this.#artifacts.readProjectRevision(project.id, revisionId);
			history.push(revision);
			revisionId = revision.parentId;
		}
		return history.reverse().map((revision) => this.#cloudRevision(revision));
	}

	async readRevision(input: ReadCloudProjectRevisionInput): Promise<CloudProjectRevisionSnapshot> {
		this.#authorize(input.projectId, input.actorId, "project.read");
		const revision = this.#artifacts.readProjectRevision(input.projectId, input.revisionId);
		const candidate = this.#artifacts.snapshotForProject(input.projectId, input.revisionId);
		return {
			revision: this.#cloudRevision(revision),
			candidate: {
				baseRevisionId: candidate.baseRevisionId,
				artifacts: candidate.artifacts
					.map((artifact) => ({
						identity: copyArtifactIdentity(artifact.identity),
						path: artifact.path,
						mediaType: artifact.mediaType,
						bytes: cloneBytes(artifact.bytes),
					}))
					.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
			},
		};
	}

	async readVersion(input: ReadCloudProjectInput & { artifactVersionId: string }): Promise<ArtifactVersion> {
		this.#authorize(input.projectId, input.actorId, "project.read");
		const versionId = normalizeCloudProjectStoreString(input.artifactVersionId, "artifactVersion.id");
		const belongsToProject = (await this.history(input)).some((revision) =>
			revision.artifacts.some((artifact) => artifact.artifactVersionId === versionId),
		);
		if (!belongsToProject) {
			throw new ArtifactError(
				"artifact_version_project_mismatch",
				`Artifact version ${versionId} does not belong to Project ${input.projectId}`,
			);
		}
		const version = this.#artifacts.readVersion(versionId);
		return { id: version.id, mediaType: version.mediaType, bytes: cloneBytes(version.bytes) };
	}

	/** store 里的版本只剩位置，Cloud 对外的版本还要带上它自己的逐 artifact 清单。 */
	#cloudRevision(revision: ProjectRevision): CloudProjectRevision {
		return cloneRevision({ ...revision, artifacts: this.#artifacts.readRevisionArtifacts(revision.id) });
	}

	#authorize(
		projectIdValue: string,
		actorIdValue: string,
		capability: Parameters<typeof assertCloudProjectCapability>[1],
	): void {
		const projectId = normalizeCloudProjectStoreString(projectIdValue, "project.id");
		const actorId = normalizeCloudProjectStoreString(actorIdValue, "project.actorId");
		assertCloudProjectCapability(this.#members.get(projectId)?.get(actorId), capability);
	}

	#requireProject(projectId: string): CloudProjectRecord {
		const project = this.#projects.get(projectId);
		if (project === undefined)
			throw new CloudStoreError("cloud_project_not_found", `Cloud Project not found: ${projectId}`);
		return project;
	}

	#timestamp(): string {
		const value = this.#now();
		if (!Number.isFinite(value.getTime()))
			throw new CloudStoreError("invalid_cloud_store_input", "Clock returned invalid time");
		return value.toISOString();
	}
}
