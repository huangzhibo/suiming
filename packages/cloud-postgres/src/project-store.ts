import { randomUUID } from "node:crypto";
import {
	type ArtifactCandidate,
	type ArtifactCandidateValidator,
	ArtifactError,
	type ArtifactIdentity,
	type ArtifactVersion,
	applyChangeOperations,
	artifactIdentityKey,
	assertCloudProjectCapability,
	type CandidateArtifact,
	type ChangeOperation,
	type ChangeSet,
	CLOUD_PROJECT_ROLES,
	type CloudObjectStore,
	type CloudProjectCapability,
	type CloudProjectRecord,
	type CloudProjectRevision,
	type CloudProjectRevisionSnapshot,
	type CloudProjectRole,
	type CloudProjectStore,
	CloudStoreError,
	type CommitCloudProjectInput,
	type CreateCloudProjectInput,
	cloudCommitProjectIdempotencyPayload,
	cloudCreateProjectIdempotencyPayload,
	cloudIdempotencyFingerprint,
	cloudSetProjectMemberIdempotencyPayload,
	compareArtifactIdentities,
	copyArtifactIdentity,
	InMemoryArtifactStore,
	normalizeCloudProjectStoreString,
	type PreparedCloudArtifactVersion,
	prepareCloudArtifactVersion,
	type ReadCloudProjectInput,
	type ReadCloudProjectRevisionInput,
	type SetCloudProjectMemberInput,
} from "@suiming/runtime";
import { type Kysely, sql } from "kysely";
import {
	type PostgresArtifactVersionRow,
	PostgresArtifactVersionStorage,
	postgresContentHash,
} from "./artifact-version-store.js";
import type { CloudPostgresDatabase } from "./database.js";

type DatabaseExecutor = Kysely<Record<string, never>>;

interface ProjectRow {
	id: string;
	head_revision_id: string;
	created_by: string;
	created_at: Date | string;
	updated_at: Date | string;
	role: string | null;
}

interface RevisionRow {
	id: string;
	parent_id: string | null;
}

interface RevisionArtifactRow {
	namespace_kind: "target" | "source";
	source_id: string;
	artifact_kind: string;
	local_id: string;
	artifact_version_id: string;
	/** Open Story Directory 里的路径。git 的 tree 天然带它，按 identity 存的 store 要自己存一份。 */
	path: string;
}

interface RevisionCandidateRow extends RevisionArtifactRow, PostgresArtifactVersionRow {}

interface IdempotencyReceiptRow {
	fingerprint: string;
	result_json: unknown;
}

interface PersistedArtifact {
	identity: ArtifactIdentity;
	path: string;
	artifactVersionId: string;
}

interface PreparedRevisionContent {
	versions: PreparedCloudArtifactVersion[];
	artifacts: PersistedArtifact[];
	operations: unknown[];
}

interface IdempotencyScope {
	projectId: string;
	actorId: string;
	operation: string;
	idempotencyKey: string;
	fingerprint: string;
}

export interface PostgresCloudProjectStoreOptions {
	database: CloudPostgresDatabase;
	objects: CloudObjectStore;
	inlineTextThresholdBytes?: number;
	now?: () => Date;
}

function timestamp(value: Date | string, label: string): string {
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) {
		throw new CloudStoreError("cloud_store_corrupt", `${label} contains an invalid timestamp`);
	}
	return date.toISOString();
}

function identityFromRow(row: RevisionArtifactRow): ArtifactIdentity {
	return row.namespace_kind === "target"
		? { namespace: { kind: "target" }, kind: row.artifact_kind, localId: row.local_id }
		: {
				namespace: { kind: "source", sourceId: row.source_id },
				kind: row.artifact_kind,
				localId: row.local_id,
			};
}

function identityColumns(identity: ArtifactIdentity): readonly [string, string, string, string] {
	return [
		identity.namespace.kind,
		identity.namespace.kind === "source" ? identity.namespace.sourceId : "",
		identity.kind,
		identity.localId,
	];
}

function revisionResultId(value: unknown): string {
	if (
		typeof value !== "object" ||
		value === null ||
		!("revisionId" in value) ||
		typeof value.revisionId !== "string" ||
		value.revisionId.length === 0
	) {
		throw new CloudStoreError("cloud_store_corrupt", "Idempotency receipt has an invalid revision result");
	}
	return value.revisionId;
}

function memberResultRole(value: unknown): CloudProjectRole {
	if (
		typeof value !== "object" ||
		value === null ||
		!("role" in value) ||
		typeof value.role !== "string" ||
		!CLOUD_PROJECT_ROLES.includes(value.role as CloudProjectRole)
	) {
		throw new CloudStoreError("cloud_store_corrupt", "Idempotency receipt has an invalid member result");
	}
	return value.role as CloudProjectRole;
}

function normalizeRole(value: CloudProjectRole): CloudProjectRole {
	if (!CLOUD_PROJECT_ROLES.includes(value)) {
		throw new CloudStoreError("invalid_cloud_store_input", `Unknown Cloud Project role: ${String(value)}`);
	}
	return value;
}

function cloneArtifact(artifact: CandidateArtifact): CandidateArtifact {
	return {
		identity: copyArtifactIdentity(artifact.identity),
		path: artifact.path,
		mediaType: artifact.mediaType,
		bytes: new Uint8Array(artifact.bytes),
	};
}

/** PostgreSQL implementation of the deployment-neutral CloudProjectStore port. */
export class PostgresCloudProjectStore implements CloudProjectStore {
	readonly #database: CloudPostgresDatabase;
	readonly #objects: CloudObjectStore;
	readonly #versions: PostgresArtifactVersionStorage;
	readonly #inlineThreshold: number;
	readonly #now: () => Date;

	constructor(options: PostgresCloudProjectStoreOptions) {
		this.#database = options.database;
		this.#objects = options.objects;
		this.#versions = new PostgresArtifactVersionStorage(options.objects, "cloud_store_corrupt");
		this.#inlineThreshold = options.inlineTextThresholdBytes ?? 256 * 1024;
		if (!Number.isSafeInteger(this.#inlineThreshold) || this.#inlineThreshold < 0) {
			throw new CloudStoreError(
				"invalid_cloud_store_input",
				"inlineTextThresholdBytes must be a non-negative safe integer",
			);
		}
		this.#now = options.now ?? (() => new Date());
	}

	async createProject(
		input: CreateCloudProjectInput,
		validate: ArtifactCandidateValidator,
	): Promise<CloudProjectRevision> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const idempotencyKey = normalizeCloudProjectStoreString(input.idempotencyKey, "idempotency.key");
		const scope = this.#scope(
			projectId,
			actorId,
			"project.create",
			idempotencyKey,
			cloudCreateProjectIdempotencyPayload(input.artifacts),
		);
		const replayed = await this.#replayedRevision(this.#database, scope);
		if (replayed !== undefined) return replayed;

		const candidate = this.#validateGenesis(input.artifacts, validate);
		const prepared = await this.#prepareRevisionContent(candidate.artifacts, []);
		const revision: CloudProjectRevision = {
			id: `pr_${randomUUID()}`,
			parentId: null,
			artifacts: prepared.artifacts
				.map((artifact) => ({
					identity: copyArtifactIdentity(artifact.identity),
					artifactVersionId: artifact.artifactVersionId,
				}))
				.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
		};

		return this.#database.transaction().execute(async (transaction) => {
			await sql`SELECT pg_advisory_xact_lock(
				hashtext('suiming.cloud-project.create.v1'),
				hashtext(${projectId})
			)`.execute(transaction);
			const concurrentReplay = await this.#replayedRevision(transaction, scope);
			if (concurrentReplay !== undefined) return concurrentReplay;
			const existing = await sql<{ found: number }>`
				SELECT 1 AS found FROM suiming.projects WHERE id = ${projectId}
			`.execute(transaction);
			if (existing.rows.length > 0) {
				throw new ArtifactError("project_already_exists", `Project already exists: ${projectId}`);
			}

			const now = this.#timestamp();
			await sql`
				INSERT INTO suiming.projects (id, head_revision_id, created_by, created_at, updated_at)
				VALUES (${projectId}, ${revision.id}, ${actorId}, ${now}, ${now})
			`.execute(transaction);
			await sql`
				INSERT INTO suiming.project_members (project_id, actor_id, role, created_at, updated_at)
				VALUES (${projectId}, ${actorId}, 'owner', ${now}, ${now})
			`.execute(transaction);
			await this.#versions.insert(transaction, prepared.versions);
			await sql`
				INSERT INTO suiming.project_revisions
					(id, project_id, parent_id, change_set_id, created_by, created_at)
				VALUES (${revision.id}, ${projectId}, NULL, NULL, ${actorId}, ${now})
			`.execute(transaction);
			await this.#insertRevisionArtifacts(transaction, projectId, revision.id, prepared.artifacts);
			await this.#insertReceipt(transaction, scope, { revisionId: revision.id }, now);
			return revision;
		});
	}

	async commit(input: CommitCloudProjectInput, validate: ArtifactCandidateValidator): Promise<CloudProjectRevision> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const idempotencyKey = normalizeCloudProjectStoreString(input.idempotencyKey, "idempotency.key");
		const scope = this.#scope(
			projectId,
			actorId,
			"revision.commit",
			idempotencyKey,
			cloudCommitProjectIdempotencyPayload(input.changeSet),
		);
		const project = await this.#authorizedProject(this.#database, projectId, actorId, "project.write");
		const replayed = await this.#replayedRevision(this.#database, scope);
		if (replayed !== undefined) return replayed;
		if (project.headRevisionId !== input.changeSet.baseRevisionId) {
			throw new ArtifactError(
				"revision_conflict",
				`Project head is ${project.headRevisionId}; ChangeSet is based on ${input.changeSet.baseRevisionId}`,
			);
		}

		const base = await this.#readRevisionSnapshot(this.#database, projectId, input.changeSet.baseRevisionId);
		const candidate = this.#applyAndValidate(base.candidate, input.changeSet, validate);
		const prepared = await this.#prepareRevisionContent(candidate.artifacts, input.changeSet.operations, base);
		const revision: CloudProjectRevision = {
			id: `pr_${randomUUID()}`,
			parentId: input.changeSet.baseRevisionId,
			artifacts: prepared.artifacts
				.map((artifact) => ({
					identity: copyArtifactIdentity(artifact.identity),
					artifactVersionId: artifact.artifactVersionId,
				}))
				.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
		};
		const changeSetId = `cs_${randomUUID()}`;

		return this.#database.transaction().execute(async (transaction) => {
			const locked = await this.#authorizedProject(transaction, projectId, actorId, "project.write", true);
			const concurrentReplay = await this.#replayedRevision(transaction, scope);
			if (concurrentReplay !== undefined) return concurrentReplay;
			if (locked.headRevisionId !== input.changeSet.baseRevisionId) {
				throw new ArtifactError(
					"revision_conflict",
					`Project head changed while committing ${input.changeSet.baseRevisionId}`,
				);
			}

			const now = this.#timestamp();
			await this.#versions.insert(transaction, prepared.versions);
			await sql`
				INSERT INTO suiming.change_sets
					(id, project_id, base_revision_id, operations_json, created_by, created_at)
				VALUES (
					${changeSetId}, ${projectId}, ${input.changeSet.baseRevisionId},
					${JSON.stringify(prepared.operations)}::jsonb, ${actorId}, ${now}
				)
			`.execute(transaction);
			await sql`
				INSERT INTO suiming.project_revisions
					(id, project_id, parent_id, change_set_id, created_by, created_at)
				VALUES (
					${revision.id}, ${projectId}, ${input.changeSet.baseRevisionId},
					${changeSetId}, ${actorId}, ${now}
				)
			`.execute(transaction);
			await this.#insertRevisionArtifacts(transaction, projectId, revision.id, prepared.artifacts);
			const updated = await sql<{ id: string }>`
				UPDATE suiming.projects
				SET head_revision_id = ${revision.id}, updated_at = ${now}
				WHERE id = ${projectId} AND head_revision_id = ${input.changeSet.baseRevisionId}
				RETURNING id
			`.execute(transaction);
			if (updated.rows.length !== 1) throw new ArtifactError("revision_conflict", "Project head changed");
			await this.#insertReceipt(transaction, scope, { revisionId: revision.id }, now);
			return revision;
		});
	}

	async setMember(input: SetCloudProjectMemberInput): Promise<CloudProjectRole> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const memberActorId = normalizeCloudProjectStoreString(input.memberActorId, "project.memberActorId");
		const role = normalizeRole(input.role);
		const idempotencyKey = normalizeCloudProjectStoreString(input.idempotencyKey, "idempotency.key");
		const scope = this.#scope(
			projectId,
			actorId,
			"project.member.set",
			idempotencyKey,
			cloudSetProjectMemberIdempotencyPayload(memberActorId, role),
		);

		return this.#database.transaction().execute(async (transaction) => {
			await this.#authorizedProject(transaction, projectId, actorId, "project.manage", true);
			const receipt = await this.#receipt(transaction, scope);
			if (receipt !== undefined) return memberResultRole(receipt.result_json);

			const current = await sql<{ role: CloudProjectRole }>`
				SELECT role
				FROM suiming.project_members
				WHERE project_id = ${projectId} AND actor_id = ${memberActorId}
			`.execute(transaction);
			if (current.rows[0]?.role === "owner" && role !== "owner") {
				const owners = await sql<{ count: string }>`
					SELECT count(*)::text AS count
					FROM suiming.project_members
					WHERE project_id = ${projectId} AND role = 'owner'
				`.execute(transaction);
				if (owners.rows[0]?.count === "1") {
					throw new CloudStoreError("cloud_last_owner", "A Cloud Project must retain at least one owner");
				}
			}

			const now = this.#timestamp();
			await sql`
				INSERT INTO suiming.project_members (project_id, actor_id, role, created_at, updated_at)
				VALUES (${projectId}, ${memberActorId}, ${role}, ${now}, ${now})
				ON CONFLICT (project_id, actor_id) DO UPDATE
				SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at
			`.execute(transaction);
			await sql`
				UPDATE suiming.projects SET updated_at = ${now} WHERE id = ${projectId}
			`.execute(transaction);
			await this.#insertReceipt(transaction, scope, { role }, now);
			return role;
		});
	}

	async project(input: ReadCloudProjectInput): Promise<CloudProjectRecord> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		return this.#authorizedProject(this.#database, projectId, actorId, "project.read");
	}

	async role(input: ReadCloudProjectInput): Promise<CloudProjectRole | undefined> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const result = await sql<{ role: string }>`
			SELECT role
			FROM suiming.project_members
			WHERE project_id = ${projectId} AND actor_id = ${actorId}
		`.execute(this.#database);
		const value = result.rows[0]?.role;
		if (value === undefined) return undefined;
		if (!CLOUD_PROJECT_ROLES.includes(value as CloudProjectRole)) {
			throw new CloudStoreError("cloud_store_corrupt", `Unknown stored Cloud Project role: ${value}`);
		}
		return value as CloudProjectRole;
	}

	async history(input: ReadCloudProjectInput): Promise<CloudProjectRevision[]> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const project = await this.#authorizedProject(this.#database, projectId, actorId, "project.read");
		const revisions = await sql<RevisionRow>`
			SELECT id, parent_id
			FROM suiming.project_revisions
			WHERE project_id = ${projectId}
		`.execute(this.#database);
		const artifacts = await sql<RevisionArtifactRow & { revision_id: string }>`
			SELECT revision_id, namespace_kind, source_id, artifact_kind, local_id, artifact_version_id, path
			FROM suiming.revision_artifacts
			WHERE project_id = ${projectId}
		`.execute(this.#database);
		const artifactsByRevision = new Map<string, RevisionArtifactRow[]>();
		for (const row of artifacts.rows) {
			const entries = artifactsByRevision.get(row.revision_id) ?? [];
			entries.push(row);
			artifactsByRevision.set(row.revision_id, entries);
		}
		const byId = new Map(
			revisions.rows.map((row) => [
				row.id,
				{
					id: row.id,
					parentId: row.parent_id,
					artifacts: (artifactsByRevision.get(row.id) ?? [])
						.map((artifact) => ({
							identity: identityFromRow(artifact),
							artifactVersionId: artifact.artifact_version_id,
						}))
						.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
				},
			]),
		);
		const result: CloudProjectRevision[] = [];
		const visited = new Set<string>();
		let revisionId: string | null = project.headRevisionId;
		while (revisionId !== null) {
			if (visited.has(revisionId)) {
				throw new CloudStoreError("cloud_store_corrupt", `ProjectRevision history contains a cycle: ${revisionId}`);
			}
			visited.add(revisionId);
			const revision = byId.get(revisionId);
			if (revision === undefined) {
				throw new CloudStoreError("cloud_store_corrupt", `ProjectRevision history is missing ${revisionId}`);
			}
			result.push(revision);
			revisionId = revision.parentId;
		}
		return result.reverse();
	}

	async readRevision(input: ReadCloudProjectRevisionInput): Promise<CloudProjectRevisionSnapshot> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const revisionId = normalizeCloudProjectStoreString(input.revisionId, "revision.id");
		await this.#authorizedProject(this.#database, projectId, actorId, "project.read");
		return this.#readRevisionSnapshot(this.#database, projectId, revisionId);
	}

	/** Trusted Worker/Agent read; public user paths must continue through the actor-authorized methods above. */
	async readCandidate(input: { projectId: string; revisionId: string }): Promise<ArtifactCandidate> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const revisionId = normalizeCloudProjectStoreString(input.revisionId, "revision.id");
		return (await this.#readRevisionSnapshot(this.#database, projectId, revisionId)).candidate;
	}

	async readVersion(input: ReadCloudProjectInput & { artifactVersionId: string }): Promise<ArtifactVersion> {
		const projectId = normalizeCloudProjectStoreString(input.projectId, "project.id");
		const actorId = normalizeCloudProjectStoreString(input.actorId, "project.actorId");
		const artifactVersionId = normalizeCloudProjectStoreString(input.artifactVersionId, "artifactVersion.id");
		await this.#authorizedProject(this.#database, projectId, actorId, "project.read");
		const linked = await sql<{ found: number }>`
			SELECT 1 AS found
			FROM suiming.revision_artifacts
			WHERE project_id = ${projectId} AND artifact_version_id = ${artifactVersionId}
			LIMIT 1
		`.execute(this.#database);
		if (linked.rows.length === 0) {
			throw new ArtifactError(
				"artifact_version_project_mismatch",
				`Artifact version ${artifactVersionId} does not belong to Project ${projectId}`,
			);
		}
		return this.#versions.read(
			this.#database,
			artifactVersionId,
			() => new ArtifactError("artifact_version_not_found", `Artifact version not found: ${artifactVersionId}`),
		);
	}

	#validateGenesis(artifacts: readonly CandidateArtifact[], validate: ArtifactCandidateValidator): ArtifactCandidate {
		const evaluator = new InMemoryArtifactStore();
		const revision = evaluator.createProject("cloud-project-validation", artifacts, validate);
		const candidate = evaluator.snapshot(revision.id);
		return {
			baseRevisionId: "genesis",
			artifacts: candidate.artifacts.map(cloneArtifact),
		};
	}

	#applyAndValidate(
		base: ArtifactCandidate,
		changeSet: ChangeSet,
		validate: ArtifactCandidateValidator,
	): ArtifactCandidate {
		const artifacts = applyChangeOperations(base.artifacts.map(cloneArtifact), changeSet.operations);
		const candidate = { baseRevisionId: changeSet.baseRevisionId, artifacts };
		validate(candidate);
		return candidate;
	}

	async #prepareRevisionContent(
		artifacts: readonly CandidateArtifact[],
		operations: readonly ChangeOperation[],
		base?: CloudProjectRevisionSnapshot,
	): Promise<PreparedRevisionContent> {
		const versions = new Map<string, PreparedCloudArtifactVersion>();
		const prepare = async (mediaType: string, bytes: Uint8Array): Promise<PreparedCloudArtifactVersion> => {
			const prepared = await prepareCloudArtifactVersion(mediaType, bytes, this.#objects, {
				inlineTextThresholdBytes: this.#inlineThreshold,
			});
			const existing = versions.get(prepared.id);
			if (existing !== undefined) return existing;
			versions.set(prepared.id, prepared);
			return prepared;
		};

		const operationVersions = new Map<number, PreparedCloudArtifactVersion>();
		for (const [index, operation] of operations.entries()) {
			if (operation.operation === "create" || operation.operation === "replace") {
				operationVersions.set(index, await prepare(operation.mediaType, operation.bytes));
			}
		}

		// 内容没变就复用上一个版本的对象，不重新上传。内容在候选里，版本 id 在版本清单里，按 identity 对上。
		const baseContent = new Map(
			(base?.candidate.artifacts ?? []).map((artifact) => [artifactIdentityKey(artifact.identity), artifact]),
		);
		const baseVersionId = new Map(
			(base?.revision.artifacts ?? []).map((artifact) => [
				artifactIdentityKey(artifact.identity),
				artifact.artifactVersionId,
			]),
		);
		const persistedArtifacts: PersistedArtifact[] = [];
		for (const artifact of artifacts) {
			const key = artifactIdentityKey(artifact.identity);
			const previous = baseContent.get(key);
			const previousVersionId = baseVersionId.get(key);
			if (
				previous !== undefined &&
				previousVersionId !== undefined &&
				previous.mediaType === artifact.mediaType &&
				postgresContentHash(previous.bytes) === postgresContentHash(artifact.bytes)
			) {
				persistedArtifacts.push({
					identity: copyArtifactIdentity(artifact.identity),
					path: artifact.path,
					artifactVersionId: previousVersionId,
				});
				continue;
			}
			const prepared = await prepare(artifact.mediaType, artifact.bytes);
			persistedArtifacts.push({
				identity: copyArtifactIdentity(artifact.identity),
				path: artifact.path,
				artifactVersionId: prepared.id,
			});
		}

		return {
			versions: [...versions.values()].sort((left, right) => left.id.localeCompare(right.id)),
			artifacts: persistedArtifacts.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
			operations: operations.map((operation, index) => {
				if (operation.operation === "delete") {
					return { operation: "delete", identity: operation.identity };
				}
				const version = operationVersions.get(index);
				if (version === undefined) {
					throw new CloudStoreError("cloud_store_corrupt", "Prepared ChangeSet content is missing");
				}
				return {
					operation: operation.operation,
					identity: operation.identity,
					mediaType: version.mediaType,
					artifactVersionId: version.id,
				};
			}),
		};
	}

	async #authorizedProject(
		executor: DatabaseExecutor,
		projectId: string,
		actorId: string,
		capability: CloudProjectCapability,
		lock = false,
	): Promise<CloudProjectRecord> {
		const result = await sql<ProjectRow>`
			SELECT p.id, p.head_revision_id, p.created_by, p.created_at, p.updated_at, pm.role
			FROM suiming.projects p
			LEFT JOIN suiming.project_members pm
				ON pm.project_id = p.id AND pm.actor_id = ${actorId}
			WHERE p.id = ${projectId}
			${lock ? sql`FOR UPDATE OF p` : sql``}
		`.execute(executor);
		const row = result.rows[0];
		const role = row?.role ?? undefined;
		if (role !== undefined && !CLOUD_PROJECT_ROLES.includes(role as CloudProjectRole)) {
			throw new CloudStoreError("cloud_store_corrupt", `Unknown stored Cloud Project role: ${role}`);
		}
		assertCloudProjectCapability(role as CloudProjectRole | undefined, capability);
		if (row === undefined) {
			throw new CloudStoreError("cloud_project_not_found", `Cloud Project not found: ${projectId}`);
		}
		return {
			id: row.id,
			headRevisionId: row.head_revision_id,
			createdBy: row.created_by,
			createdAt: timestamp(row.created_at, "project.createdAt"),
			updatedAt: timestamp(row.updated_at, "project.updatedAt"),
		};
	}

	async #readRevision(
		executor: DatabaseExecutor,
		projectId: string,
		revisionId: string,
	): Promise<CloudProjectRevision> {
		const revision = await sql<RevisionRow>`
			SELECT id, parent_id
			FROM suiming.project_revisions
			WHERE project_id = ${projectId} AND id = ${revisionId}
		`.execute(executor);
		const row = revision.rows[0];
		if (row === undefined) {
			throw new ArtifactError(
				"revision_project_mismatch",
				`ProjectRevision ${revisionId} does not belong to ${projectId}`,
			);
		}
		const artifacts = await sql<RevisionArtifactRow>`
			SELECT namespace_kind, source_id, artifact_kind, local_id, artifact_version_id, path
			FROM suiming.revision_artifacts
			WHERE project_id = ${projectId} AND revision_id = ${revisionId}
		`.execute(executor);
		return {
			id: row.id,
			parentId: row.parent_id,
			artifacts: artifacts.rows
				.map((artifact) => ({
					identity: identityFromRow(artifact),
					artifactVersionId: artifact.artifact_version_id,
				}))
				.sort((left, right) => compareArtifactIdentities(left.identity, right.identity)),
		};
	}

	async #readRevisionSnapshot(
		executor: DatabaseExecutor,
		projectId: string,
		revisionId: string,
	): Promise<CloudProjectRevisionSnapshot> {
		const revision = await this.#readRevision(executor, projectId, revisionId);
		const artifacts = await sql<RevisionCandidateRow>`
			SELECT
				ra.namespace_kind, ra.source_id, ra.artifact_kind, ra.local_id, ra.artifact_version_id, ra.path,
				av.id, av.media_type, av.content_hash, av.byte_length, av.inline_bytes, av.object_key
			FROM suiming.revision_artifacts ra
			JOIN suiming.artifact_versions av ON av.id = ra.artifact_version_id
			WHERE ra.project_id = ${projectId} AND ra.revision_id = ${revisionId}
		`.execute(executor);
		if (artifacts.rows.length !== revision.artifacts.length) {
			throw new CloudStoreError("cloud_store_corrupt", `ProjectRevision ${revisionId} has missing ArtifactVersions`);
		}
		const candidateArtifacts = await Promise.all(
			artifacts.rows.map(async (row): Promise<CandidateArtifact> => {
				const version = await this.#versions.materialize(row);
				return {
					identity: identityFromRow(row),
					path: row.path,
					mediaType: version.mediaType,
					bytes: version.bytes,
				};
			}),
		);
		return {
			revision,
			candidate: {
				baseRevisionId: revision.id,
				artifacts: candidateArtifacts.sort((left, right) =>
					compareArtifactIdentities(left.identity, right.identity),
				),
			},
		};
	}

	async #insertRevisionArtifacts(
		executor: DatabaseExecutor,
		projectId: string,
		revisionId: string,
		artifacts: readonly PersistedArtifact[],
	): Promise<void> {
		for (const artifact of artifacts) {
			const [namespaceKind, sourceId, artifactKind, localId] = identityColumns(artifact.identity);
			await sql`
				INSERT INTO suiming.revision_artifacts
					(project_id, revision_id, namespace_kind, source_id, artifact_kind, local_id, artifact_version_id, path)
				VALUES (
					${projectId}, ${revisionId}, ${namespaceKind}, ${sourceId},
					${artifactKind}, ${localId}, ${artifact.artifactVersionId}, ${artifact.path}
				)
			`.execute(executor);
		}
	}

	#scope(
		projectId: string,
		actorId: string,
		operation: string,
		idempotencyKey: string,
		payload: unknown,
	): IdempotencyScope {
		return {
			projectId,
			actorId,
			operation,
			idempotencyKey,
			fingerprint: cloudIdempotencyFingerprint(payload),
		};
	}

	async #receipt(executor: DatabaseExecutor, scope: IdempotencyScope): Promise<IdempotencyReceiptRow | undefined> {
		const result = await sql<IdempotencyReceiptRow>`
			SELECT fingerprint, result_json
			FROM suiming.idempotency_receipts
			WHERE project_id = ${scope.projectId}
				AND actor_id = ${scope.actorId}
				AND operation = ${scope.operation}
				AND idempotency_key = ${scope.idempotencyKey}
		`.execute(executor);
		const receipt = result.rows[0];
		if (receipt !== undefined && receipt.fingerprint !== scope.fingerprint) {
			throw new CloudStoreError(
				"cloud_idempotency_conflict",
				"Idempotency key was already used with different input",
			);
		}
		return receipt;
	}

	async #replayedRevision(
		executor: DatabaseExecutor,
		scope: IdempotencyScope,
	): Promise<CloudProjectRevision | undefined> {
		const receipt = await this.#receipt(executor, scope);
		return receipt === undefined
			? undefined
			: this.#readRevision(executor, scope.projectId, revisionResultId(receipt.result_json));
	}

	async #insertReceipt(
		executor: DatabaseExecutor,
		scope: IdempotencyScope,
		result: unknown,
		createdAt: string,
	): Promise<void> {
		await sql`
			INSERT INTO suiming.idempotency_receipts
				(project_id, actor_id, operation, idempotency_key, fingerprint, result_json, created_at)
			VALUES (
				${scope.projectId}, ${scope.actorId}, ${scope.operation}, ${scope.idempotencyKey},
				${scope.fingerprint}, ${JSON.stringify(result)}::jsonb, ${createdAt}
			)
		`.execute(executor);
	}

	#timestamp(): string {
		const value = this.#now();
		if (!Number.isFinite(value.getTime())) {
			throw new CloudStoreError("invalid_cloud_store_input", "Clock returned invalid time");
		}
		return value.toISOString();
	}
}
