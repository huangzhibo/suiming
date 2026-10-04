/**
 * 只给测试用的内存版 Cloud store：CloudProjectService、同步与 Domain API 的测试拿它当 Cloud 后端。产品的 Cloud 存储是
 * `@suiming/cloud-postgres` 与 `@suiming/cloud-s3`，它们的权限、幂等与线性 revision 由 cloud-postgres 的集成测试守
 * （默认 skip，真跑办法见 packages/cloud-postgres/AGENTS.md）。2026-10-04 从 runtime 的产品导出面挪到这里：
 * 它们没有任何生产调用点，留在导出面上就是 AGENTS.md 删 `@suiming/runtime/testing` 时说的污染。
 */
import { canonicalJson, sha256Buffer } from "@suiming/story";
import {
	type ArtifactCandidateValidator,
	ArtifactError,
	type ArtifactVersion,
	assertCloudProjectCapability,
	type CloudObjectStore,
	type CloudProjectRecord,
	type CloudProjectRevision,
	type CloudProjectRevisionSnapshot,
	type CloudProjectRole,
	type CloudProjectStore,
	type CloudStoredObject,
	CloudStoreError,
	type CommitCloudProjectInput,
	type CreateCloudProjectInput,
	cloudCommitProjectIdempotencyPayload,
	cloudCreateProjectIdempotencyPayload,
	cloudIdempotencyFingerprint,
	cloudObjectKey,
	cloudSetProjectMemberIdempotencyPayload,
	compareArtifactIdentities,
	copyArtifactIdentity,
	InMemoryArtifactStore,
	normalizeCloudProjectStoreString,
	type ProjectRevision,
	type ReadCloudProjectInput,
	type ReadCloudProjectRevisionInput,
	type SetCloudProjectMemberInput,
} from "../src/index.js";

interface IdempotencyScope {
	projectId: string;
	actorId: string;
	operation: string;
}

/** 同一 scope 与 key：输入相同返回第一次的结果（并发时等同一个 promise），输入不同报 `cloud_idempotency_conflict`。 */
class InMemoryIdempotency {
	readonly #results = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

	async execute<T>(
		input: { scope: IdempotencyScope; idempotencyKey: string; payload: unknown },
		operation: () => T | Promise<T>,
	): Promise<T> {
		const key = canonicalJson([
			input.scope.projectId,
			input.scope.actorId,
			input.scope.operation,
			normalizeCloudProjectStoreString(input.idempotencyKey, "idempotency.key"),
		]);
		const fingerprint = cloudIdempotencyFingerprint(input.payload);
		const existing = this.#results.get(key);
		if (existing !== undefined) {
			if (existing.fingerprint !== fingerprint) {
				throw new CloudStoreError(
					"cloud_idempotency_conflict",
					"Idempotency key was already used with different input",
				);
			}
			return structuredClone((await existing.promise) as T);
		}
		const promise = Promise.resolve().then(operation);
		this.#results.set(key, { fingerprint, promise });
		try {
			return structuredClone(await promise);
		} catch (error) {
			// 失败不留回执：同一个 key 可以重试。
			if (this.#results.get(key)?.promise === promise) this.#results.delete(key);
			throw error;
		}
	}
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
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

export class InMemoryCloudProjectStore implements CloudProjectStore {
	readonly #artifacts = new InMemoryArtifactStore();
	readonly #projects = new Map<string, CloudProjectRecord>();
	readonly #members = new Map<string, Map<string, CloudProjectRole>>();
	readonly #idempotency = new InMemoryIdempotency();
	readonly #now: () => Date;

	constructor(options: { now?: () => Date } = {}) {
		this.#now = options.now ?? (() => new Date());
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

export class InMemoryCloudObjectStore implements CloudObjectStore {
	readonly #objects = new Map<string, Uint8Array>();

	async put(bytes: Uint8Array): Promise<CloudStoredObject> {
		const contentHash = sha256Buffer(bytes);
		this.#objects.set(contentHash, new Uint8Array(bytes));
		return { contentHash, objectKey: cloudObjectKey(contentHash), byteLength: bytes.byteLength };
	}

	async read(contentHash: string): Promise<Uint8Array> {
		cloudObjectKey(contentHash);
		const bytes = this.#objects.get(contentHash);
		if (bytes === undefined) {
			throw new CloudStoreError("cloud_object_not_found", `Cloud object not found: ${contentHash}`);
		}
		return new Uint8Array(bytes);
	}

	async delete(contentHash: string): Promise<void> {
		cloudObjectKey(contentHash);
		this.#objects.delete(contentHash);
	}
}
