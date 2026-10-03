import type { DomainApiClient } from "@suiming/sdk";
import { applyChangeOperations } from "../artifact/change-operations.js";
import { artifactIdentityKey } from "../artifact/identity.js";
import { candidateFromOpenStoryFiles, openStoryFilesFromCandidate } from "../artifact/open-story-snapshot.js";
import type { ArtifactCandidateValidator } from "../artifact/types.js";
import type {
	CloudProjectRecord,
	CloudProjectRevision,
	CloudProjectRevisionSnapshot,
	CloudProjectStore,
	CommitCloudProjectInput,
	CreateCloudProjectInput,
	ReadCloudProjectInput,
	ReadCloudProjectRevisionInput,
	SetCloudProjectMemberInput,
} from "../cloud/cloud-project-store.js";
import { CloudStoreError } from "../cloud/errors.js";
import type { CloudProjectRole } from "../cloud/project-access.js";

export type DomainApiProjectClient = Pick<
	DomainApiClient,
	| "importProject"
	| "readProject"
	| "setProjectMember"
	| "history"
	| "commitRevision"
	| "readRevision"
	| "exportRevision"
	| "readArtifactVersion"
>;

export interface DomainApiCloudProjectStoreOptions {
	client: DomainApiProjectClient;
	actorId: string;
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_remote_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function revision(value: {
	id: string;
	parentId: string | null;
	artifacts: Array<{
		identity: {
			namespace: { kind: "target" } | { kind: "source"; sourceId: string };
			kind: string;
			localId: string;
		};
		artifactVersionId: string;
	}>;
}): CloudProjectRevision {
	return structuredClone(value);
}

/** CloudProjectStore adapter used by LocalCloudSyncService over the public Domain API. */
export class DomainApiCloudProjectStore implements CloudProjectStore {
	readonly #client: DomainApiProjectClient;
	readonly #actorId: string;

	constructor(options: DomainApiCloudProjectStoreOptions) {
		this.#client = options.client;
		this.#actorId = nonempty(options.actorId, "actorId");
	}

	async createProject(
		input: CreateCloudProjectInput,
		validate: ArtifactCandidateValidator,
	): Promise<CloudProjectRevision> {
		this.#assertActor(input.actorId);
		const candidate = { baseRevisionId: "cloud-import", artifacts: [...input.artifacts] };
		validate(candidate);
		const value = await this.#client.importProject({
			projectId: input.projectId,
			idempotencyKey: input.idempotencyKey,
			files: openStoryFilesFromCandidate(candidate),
		});
		if (value.project.id !== input.projectId || value.revision.parentId !== null) this.#invalidResponse();
		return revision(value.revision);
	}

	async commit(input: CommitCloudProjectInput, validate: ArtifactCandidateValidator): Promise<CloudProjectRevision> {
		this.#assertActor(input.actorId);
		const files = await this.#client.exportRevision(input.projectId, input.changeSet.baseRevisionId);
		const base = candidateFromOpenStoryFiles(files, input.changeSet.baseRevisionId);
		const next: Parameters<ArtifactCandidateValidator>[0] = {
			baseRevisionId: input.changeSet.baseRevisionId,
			artifacts: applyChangeOperations(base.artifacts, input.changeSet.operations),
		};
		validate(next);
		const value = await this.#client.commitRevision({
			projectId: input.projectId,
			idempotencyKey: input.idempotencyKey,
			baseRevisionId: input.changeSet.baseRevisionId,
			files: openStoryFilesFromCandidate(next),
		});
		if (value.projectId !== input.projectId || value.revision.parentId !== input.changeSet.baseRevisionId) {
			this.#invalidResponse();
		}
		return revision(value.revision);
	}

	async setMember(input: SetCloudProjectMemberInput): Promise<CloudProjectRole> {
		this.#assertActor(input.actorId);
		return this.#client.setProjectMember({
			projectId: input.projectId,
			memberActorId: input.memberActorId,
			role: input.role,
			idempotencyKey: input.idempotencyKey,
		});
	}

	async project(input: ReadCloudProjectInput): Promise<CloudProjectRecord> {
		this.#assertActor(input.actorId);
		const value = await this.#client.readProject(input.projectId);
		if (value.id !== input.projectId) this.#invalidResponse();
		return {
			id: value.id,
			headRevisionId: value.headRevisionId,
			createdBy: value.createdBy,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	}

	async role(input: ReadCloudProjectInput): Promise<CloudProjectRole | undefined> {
		if (input.actorId !== this.#actorId) return undefined;
		return (await this.#client.readProject(input.projectId)).role;
	}

	async history(input: ReadCloudProjectInput): Promise<CloudProjectRevision[]> {
		this.#assertActor(input.actorId);
		const value = await this.#client.history(input.projectId);
		if (value.projectId !== input.projectId) this.#invalidResponse();
		return value.revisions.map(revision);
	}

	async readRevision(input: ReadCloudProjectRevisionInput): Promise<CloudProjectRevisionSnapshot> {
		this.#assertActor(input.actorId);
		const [metadata, files] = await Promise.all([
			this.#client.readRevision(input.projectId, input.revisionId),
			this.#client.exportRevision(input.projectId, input.revisionId),
		]);
		if (metadata.projectId !== input.projectId || metadata.revision.id !== input.revisionId) this.#invalidResponse();
		const candidate = candidateFromOpenStoryFiles(files, input.revisionId);
		// 导出的文件与版本清单必须是同一份内容：条数相同，且每个候选 artifact 都在清单里。
		const listed = new Set(metadata.revision.artifacts.map((artifact) => artifactIdentityKey(artifact.identity)));
		if (listed.size !== candidate.artifacts.length) this.#invalidResponse();
		for (const artifact of candidate.artifacts) {
			if (!listed.has(artifactIdentityKey(artifact.identity))) this.#invalidResponse();
		}
		return {
			revision: revision(metadata.revision),
			candidate,
		};
	}

	async readVersion(input: ReadCloudProjectInput & { artifactVersionId: string }) {
		this.#assertActor(input.actorId);
		return this.#client.readArtifactVersion(input.projectId, input.artifactVersionId);
	}

	#assertActor(actorIdValue: string): void {
		if (nonempty(actorIdValue, "actorId") !== this.#actorId) {
			throw new CloudStoreError(
				"cloud_actor_mismatch",
				"Domain API client credential does not represent the requested actor",
			);
		}
	}

	#invalidResponse(): never {
		throw new CloudStoreError("cloud_remote_integrity_error", "Cloud Domain API returned inconsistent project data");
	}
}
