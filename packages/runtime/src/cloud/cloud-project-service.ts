import type { OpenPackageFile } from "../artifact/open-package.js";
import {
	candidateFromOpenStoryFiles,
	changeOperationsBetweenCandidates,
	openStoryFilesFromCandidate,
} from "../artifact/open-story-snapshot.js";
import { validateStoryProjectCandidate } from "../artifact/story-design-validator.js";
import type { ArtifactVersion } from "../artifact/types.js";
import {
	compareOpenStoryFiles,
	type OpenStorySyncDelta,
	openStoryContentFingerprint,
} from "../sync/open-story-merge.js";
import type {
	CloudProjectRecord,
	CloudProjectRevision,
	CloudProjectRevisionSnapshot,
	CloudProjectStore,
	ReadCloudProjectInput,
	SetCloudProjectMemberInput,
} from "./cloud-project-store.js";
import { CloudStoreError } from "./errors.js";
import type { CloudProjectRole } from "./project-access.js";

export interface CloudProjectView {
	project: CloudProjectRecord;
	role: CloudProjectRole;
}

export interface CloudRevisionView {
	snapshot: CloudProjectRevisionSnapshot;
	files: OpenPackageFile[];
	contentFingerprint: string;
}

export interface ImportCloudProjectSnapshotInput extends ReadCloudProjectInput {
	idempotencyKey: string;
	files: readonly OpenPackageFile[];
}

export interface CommitCloudProjectSnapshotInput extends ImportCloudProjectSnapshotInput {
	baseRevisionId: string;
}

export interface DiffCloudProjectRevisionsInput extends ReadCloudProjectInput {
	baseRevisionId: string;
	revisionId: string;
}

export interface CloudProjectRevisionDiff {
	projectId: string;
	baseRevisionId: string;
	revisionId: string;
	changes: OpenStorySyncDelta[];
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudStoreError("invalid_cloud_service_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function revisionFiles(snapshot: CloudProjectRevisionSnapshot): OpenPackageFile[] {
	return openStoryFilesFromCandidate(snapshot.candidate);
}

/** Deployment-neutral Cloud application service used by API composition roots. */
export class CloudProjectService {
	readonly #store: CloudProjectStore;

	constructor(store: CloudProjectStore) {
		this.#store = store;
	}

	async importSnapshot(input: ImportCloudProjectSnapshotInput): Promise<CloudRevisionView> {
		const projectId = nonempty(input.projectId, "projectId");
		const candidate = candidateFromOpenStoryFiles(input.files, "cloud-import");
		const revision = await this.#store.createProject(
			{
				projectId,
				actorId: nonempty(input.actorId, "actorId"),
				idempotencyKey: nonempty(input.idempotencyKey, "idempotencyKey"),
				artifacts: candidate.artifacts,
			},
			validateStoryProjectCandidate,
		);
		return this.revision({ projectId, actorId: input.actorId, revisionId: revision.id });
	}

	async commitSnapshot(input: CommitCloudProjectSnapshotInput): Promise<CloudRevisionView> {
		const projectId = nonempty(input.projectId, "projectId");
		const actorId = nonempty(input.actorId, "actorId");
		const baseRevisionId = nonempty(input.baseRevisionId, "baseRevisionId");
		const baseSnapshot = await this.#store.readRevision({ projectId, actorId, revisionId: baseRevisionId });
		const baseFiles = revisionFiles(baseSnapshot);
		const nextFiles = input.files.map((file) => ({
			path: file.path,
			mediaType: file.mediaType,
			bytes: new Uint8Array(file.bytes),
		}));
		if (openStoryContentFingerprint(baseFiles) === openStoryContentFingerprint(nextFiles)) {
			throw new CloudStoreError(
				"cloud_no_changes",
				"Submitted Open Story snapshot is identical to its base revision",
			);
		}
		const nextCandidate = candidateFromOpenStoryFiles(nextFiles, baseRevisionId);
		const revision = await this.#store.commit(
			{
				projectId,
				actorId,
				idempotencyKey: nonempty(input.idempotencyKey, "idempotencyKey"),
				changeSet: {
					baseRevisionId,
					operations: changeOperationsBetweenCandidates(baseSnapshot.candidate, nextCandidate),
				},
			},
			validateStoryProjectCandidate,
		);
		return this.revision({ projectId, actorId, revisionId: revision.id });
	}

	async project(input: ReadCloudProjectInput): Promise<CloudProjectView> {
		const context = {
			projectId: nonempty(input.projectId, "projectId"),
			actorId: nonempty(input.actorId, "actorId"),
		};
		const project = await this.#store.project(context);
		const role = await this.#store.role(context);
		if (role === undefined) throw new CloudStoreError("cloud_access_denied", "Cloud Project membership disappeared");
		return { project, role };
	}

	setMember(input: SetCloudProjectMemberInput): Promise<CloudProjectRole> {
		return this.#store.setMember({
			projectId: nonempty(input.projectId, "projectId"),
			actorId: nonempty(input.actorId, "actorId"),
			idempotencyKey: nonempty(input.idempotencyKey, "idempotencyKey"),
			memberActorId: nonempty(input.memberActorId, "memberActorId"),
			role: input.role,
		});
	}

	async history(input: ReadCloudProjectInput): Promise<CloudProjectRevision[]> {
		return this.#store.history({
			projectId: nonempty(input.projectId, "projectId"),
			actorId: nonempty(input.actorId, "actorId"),
		});
	}

	async revision(input: ReadCloudProjectInput & { revisionId: string }): Promise<CloudRevisionView> {
		const snapshot = await this.#store.readRevision({
			projectId: nonempty(input.projectId, "projectId"),
			actorId: nonempty(input.actorId, "actorId"),
			revisionId: nonempty(input.revisionId, "revisionId"),
		});
		const files = revisionFiles(snapshot);
		return { snapshot, files, contentFingerprint: openStoryContentFingerprint(files) };
	}

	readVersion(input: ReadCloudProjectInput & { artifactVersionId: string }): Promise<ArtifactVersion> {
		return this.#store.readVersion({
			projectId: nonempty(input.projectId, "projectId"),
			actorId: nonempty(input.actorId, "actorId"),
			artifactVersionId: nonempty(input.artifactVersionId, "artifactVersionId"),
		});
	}

	async diff(input: DiffCloudProjectRevisionsInput): Promise<CloudProjectRevisionDiff> {
		const context = {
			projectId: nonempty(input.projectId, "projectId"),
			actorId: nonempty(input.actorId, "actorId"),
		};
		const [base, revision] = await Promise.all([
			this.revision({ ...context, revisionId: nonempty(input.baseRevisionId, "baseRevisionId") }),
			this.revision({ ...context, revisionId: nonempty(input.revisionId, "revisionId") }),
		]);
		return {
			projectId: context.projectId,
			baseRevisionId: base.snapshot.revision.id,
			revisionId: revision.snapshot.revision.id,
			changes: compareOpenStoryFiles(base.files, revision.files),
		};
	}
}
