import type { OpenPackageFile } from "../artifact/open-package.js";
import { materializeOpenStoryDirectorySnapshot } from "../artifact/open-story-directory.js";
import {
	candidateFromOpenStoryFiles,
	changeOperationsBetweenCandidates,
	openStoryFilesFromCandidate,
} from "../artifact/open-story-snapshot.js";
import { validateStoryProjectCandidate } from "../artifact/story-design-validator.js";
import type { ChangeSet, ProjectRevision } from "../artifact/types.js";
import type { CloudProjectRevisionSnapshot, CloudProjectStore } from "../cloud/cloud-project-store.js";
import { LocalProjectService } from "../local/local-project-service.js";
import type { LocalRemoteBinding } from "../local/sqlite-local-store.js";
import { CloudSyncError } from "./errors.js";
import {
	mergeOpenStoryFiles,
	type OpenStorySyncConflict,
	type OpenStorySyncDelta,
	openStoryContentFingerprint,
} from "./open-story-merge.js";

export type LocalCloudSyncState = "in_sync" | "local_ahead" | "cloud_ahead" | "diverged_mergeable" | "conflict";

export interface LocalCloudSyncStatus {
	state: LocalCloudSyncState;
	dirtyCheckout: boolean;
	binding: LocalRemoteBinding;
	localHeadRevisionId: string;
	cloudHeadRevisionId: string;
	localChanges: OpenStorySyncDelta[];
	cloudChanges: OpenStorySyncDelta[];
	conflicts: OpenStorySyncConflict[];
}

export interface LocalCloudSyncResult {
	before: LocalCloudSyncStatus;
	after: LocalCloudSyncStatus;
	localRevisionCreated: boolean;
	cloudRevisionCreated: boolean;
}

export interface LocalCloudSyncServiceOptions {
	local: LocalProjectService;
	cloud: CloudProjectStore;
	endpoint: string;
	actorId: string;
}

export interface LinkLocalCloudProjectInput {
	cloudProjectId: string;
	cloudRevisionId?: string;
}

export interface ImportLocalCloudProjectInput {
	cloudProjectId: string;
	idempotencyKey: string;
	allowDirtyCheckout?: boolean;
}

export interface PushLocalCloudProjectInput {
	idempotencyKey: string;
	allowDirtyCheckout?: boolean;
}

export interface CheckoutCloudProjectInput {
	cloud: CloudProjectStore;
	endpoint: string;
	actorId: string;
	cloudProjectId: string;
	cloudRevisionId?: string;
	destinationPath: string;
	localProjectId?: string;
}

export interface CheckoutCloudProjectResult {
	local: LocalProjectService;
	binding: LocalRemoteBinding;
	cloudRevision: ProjectRevision;
}

interface SyncAnalysis extends LocalCloudSyncStatus {
	baseCloudFiles: OpenPackageFile[];
	localFiles: OpenPackageFile[];
	cloudFiles: OpenPackageFile[];
	mergedFiles?: OpenPackageFile[];
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new CloudSyncError("invalid_cloud_sync_input", `${label} must be non-empty and contain no NUL`);
	}
	return normalized;
}

function normalizeEndpoint(value: string): string {
	let endpoint: URL;
	try {
		endpoint = new URL(nonempty(value, "endpoint"));
	} catch {
		throw new CloudSyncError("invalid_cloud_sync_input", "Cloud endpoint must be an absolute HTTP(S) URL");
	}
	if (
		(endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
		endpoint.username.length > 0 ||
		endpoint.password.length > 0 ||
		endpoint.search.length > 0 ||
		endpoint.hash.length > 0
	) {
		throw new CloudSyncError(
			"invalid_cloud_sync_input",
			"Cloud endpoint must use HTTP(S) and cannot contain credentials, query parameters, or fragments",
		);
	}
	endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") || "/";
	return endpoint.toString().replace(/\/$/u, "");
}

function cloudFiles(snapshot: CloudProjectRevisionSnapshot): OpenPackageFile[] {
	return openStoryFilesFromCandidate(snapshot.candidate);
}

function requireNoConflict(analysis: SyncAnalysis): void {
	if (analysis.state !== "conflict") return;
	throw new CloudSyncError(
		"cloud_sync_conflict",
		`Local and Cloud modified the same synchronized item: ${analysis.conflicts.map((item) => item.description).join(", ")}`,
	);
}

export class LocalCloudSyncService {
	readonly #local: LocalProjectService;
	readonly #cloud: CloudProjectStore;
	readonly #endpoint: string;
	readonly #actorId: string;

	constructor(options: LocalCloudSyncServiceOptions) {
		this.#local = options.local;
		this.#cloud = options.cloud;
		this.#endpoint = normalizeEndpoint(options.endpoint);
		this.#actorId = nonempty(options.actorId, "actorId");
	}

	static async checkout(input: CheckoutCloudProjectInput): Promise<CheckoutCloudProjectResult> {
		const endpoint = normalizeEndpoint(input.endpoint);
		const actorId = nonempty(input.actorId, "actorId");
		const cloudProjectId = nonempty(input.cloudProjectId, "cloudProjectId");
		const cloudProject = await input.cloud.project({ projectId: cloudProjectId, actorId });
		const cloudRevisionId = input.cloudRevisionId?.trim() || cloudProject.headRevisionId;
		const snapshot = await input.cloud.readRevision({
			projectId: cloudProjectId,
			actorId,
			revisionId: cloudRevisionId,
		});
		const files = cloudFiles(snapshot);
		await materializeOpenStoryDirectorySnapshot(input.destinationPath, files);
		const local = await LocalProjectService.init({
			checkoutPath: input.destinationPath,
			...(input.localProjectId === undefined ? {} : { projectId: input.localProjectId }),
		});
		try {
			const binding = local.setRemoteBinding({
				endpoint,
				cloudProjectId,
				lastSyncedCloudRevisionId: snapshot.revision.id,
				lastSyncedLocalRevisionId: local.project().headRevisionId,
				lastSyncedContentFingerprint: openStoryContentFingerprint(files),
			});
			return { local, binding, cloudRevision: snapshot.revision };
		} catch (error) {
			local.close();
			throw error;
		}
	}

	async import(
		input: ImportLocalCloudProjectInput,
	): Promise<{ binding: LocalRemoteBinding; revision: ProjectRevision }> {
		this.#requireUnlinked();
		const dirty = (await this.#local.status()).state === "dirty";
		if (dirty && input.allowDirtyCheckout !== true) this.#dirtyExcluded();
		const localProject = this.#local.project();
		const files = await this.#local.exportRevision(localProject.headRevisionId);
		const candidate = candidateFromOpenStoryFiles(files, "cloud-import");
		const cloudProjectId = nonempty(input.cloudProjectId, "cloudProjectId");
		const revision = await this.#cloud.createProject(
			{
				projectId: cloudProjectId,
				actorId: this.#actorId,
				idempotencyKey: input.idempotencyKey,
				artifacts: candidate.artifacts,
			},
			validateStoryProjectCandidate,
		);
		const binding = this.#local.setRemoteBinding({
			endpoint: this.#endpoint,
			cloudProjectId,
			lastSyncedCloudRevisionId: revision.id,
			lastSyncedLocalRevisionId: localProject.headRevisionId,
			lastSyncedContentFingerprint: openStoryContentFingerprint(files),
		});
		return { binding, revision };
	}

	async link(input: LinkLocalCloudProjectInput): Promise<LocalRemoteBinding> {
		this.#requireUnlinked();
		if ((await this.#local.status()).state !== "clean") {
			throw new CloudSyncError("cloud_sync_dirty_checkout", "Link requires a clean Open Story Directory");
		}
		const cloudProjectId = nonempty(input.cloudProjectId, "cloudProjectId");
		const project = await this.#cloud.project({ projectId: cloudProjectId, actorId: this.#actorId });
		const revisionId = input.cloudRevisionId?.trim() || project.headRevisionId;
		const snapshot = await this.#cloud.readRevision({
			projectId: cloudProjectId,
			actorId: this.#actorId,
			revisionId,
		});
		const localProject = this.#local.project();
		const localFiles = await this.#local.exportRevision(localProject.headRevisionId);
		const remoteFiles = cloudFiles(snapshot);
		const localFingerprint = openStoryContentFingerprint(localFiles);
		const remoteFingerprint = openStoryContentFingerprint(remoteFiles);
		if (localFingerprint !== remoteFingerprint) {
			throw new CloudSyncError(
				"cloud_sync_content_mismatch",
				"Local head and selected Cloud ProjectRevision do not contain the same Open Story snapshot",
			);
		}
		return this.#local.setRemoteBinding({
			endpoint: this.#endpoint,
			cloudProjectId,
			lastSyncedCloudRevisionId: snapshot.revision.id,
			lastSyncedLocalRevisionId: localProject.headRevisionId,
			lastSyncedContentFingerprint: localFingerprint,
		});
	}

	async status(): Promise<LocalCloudSyncStatus> {
		return this.#publicStatus(await this.#analyze());
	}

	async push(input: PushLocalCloudProjectInput): Promise<LocalCloudSyncResult> {
		const analysis = await this.#analyze();
		requireNoConflict(analysis);
		if (analysis.dirtyCheckout && input.allowDirtyCheckout !== true) this.#dirtyExcluded();
		if (analysis.dirtyCheckout && analysis.cloudChanges.length > 0) {
			throw new CloudSyncError(
				"cloud_sync_dirty_checkout",
				"Push cannot integrate Cloud changes while the Open Story Directory has uncommitted changes",
			);
		}
		if (analysis.localChanges.length === 0 && analysis.cloudChanges.length > 0) {
			throw new CloudSyncError(
				"cloud_sync_pull_required",
				"Cloud has changes and Local has nothing to push; pull first",
			);
		}
		const targetFiles =
			analysis.cloudChanges.length === 0 ? analysis.localFiles : (analysis.mergedFiles ?? analysis.cloudFiles);
		const cloudBase = candidateFromOpenStoryFiles(analysis.cloudFiles, analysis.cloudHeadRevisionId);
		const targetForCloud = candidateFromOpenStoryFiles(targetFiles, analysis.cloudHeadRevisionId);
		const cloudChangeSet: ChangeSet = {
			baseRevisionId: analysis.cloudHeadRevisionId,
			operations: changeOperationsBetweenCandidates(cloudBase, targetForCloud),
		};
		const cloudRevision =
			cloudChangeSet.operations.length === 0 &&
			openStoryContentFingerprint(analysis.cloudFiles) === openStoryContentFingerprint(targetFiles)
				? analysis.cloudHeadRevisionId
				: (
						await this.#cloud.commit(
							{
								projectId: analysis.binding.cloudProjectId,
								actorId: this.#actorId,
								idempotencyKey: input.idempotencyKey,
								changeSet: cloudChangeSet,
							},
							validateStoryProjectCandidate,
						)
					).id;
		const localRevision = await this.#applyLocalTarget(targetFiles);
		this.#local.setRemoteBinding({
			endpoint: this.#endpoint,
			cloudProjectId: analysis.binding.cloudProjectId,
			lastSyncedCloudRevisionId: cloudRevision,
			lastSyncedLocalRevisionId: localRevision.id,
			lastSyncedContentFingerprint: openStoryContentFingerprint(targetFiles),
		});
		return {
			before: this.#publicStatus(analysis),
			after: await this.status(),
			localRevisionCreated: localRevision.created,
			cloudRevisionCreated: cloudRevision !== analysis.cloudHeadRevisionId,
		};
	}

	async pull(): Promise<LocalCloudSyncResult> {
		const analysis = await this.#analyze();
		requireNoConflict(analysis);
		if (analysis.dirtyCheckout) {
			throw new CloudSyncError("cloud_sync_dirty_checkout", "Pull requires a clean Open Story Directory");
		}
		if (analysis.cloudChanges.length === 0) {
			return {
				before: this.#publicStatus(analysis),
				after: this.#publicStatus(analysis),
				localRevisionCreated: false,
				cloudRevisionCreated: false,
			};
		}
		const targetFiles =
			analysis.localChanges.length === 0 ? analysis.cloudFiles : (analysis.mergedFiles ?? analysis.cloudFiles);
		const localRevision = await this.#applyLocalTarget(targetFiles);
		this.#local.setRemoteBinding({
			endpoint: this.#endpoint,
			cloudProjectId: analysis.binding.cloudProjectId,
			lastSyncedCloudRevisionId: analysis.cloudHeadRevisionId,
			lastSyncedLocalRevisionId: localRevision.id,
			lastSyncedContentFingerprint: openStoryContentFingerprint(analysis.cloudFiles),
		});
		return {
			before: this.#publicStatus(analysis),
			after: await this.status(),
			localRevisionCreated: localRevision.created,
			cloudRevisionCreated: false,
		};
	}

	unlink(): LocalRemoteBinding {
		const binding = this.#binding();
		this.#local.clearRemoteBinding();
		return binding;
	}

	async #analyze(): Promise<SyncAnalysis> {
		const binding = this.#binding();
		const localProject = this.#local.project();
		if (!(await this.#local.history()).some((revision) => revision.id === binding.lastSyncedLocalRevisionId)) {
			throw new CloudSyncError(
				"cloud_sync_base_missing",
				`Local synchronization marker is no longer in Project history: ${binding.lastSyncedLocalRevisionId}`,
			);
		}
		const [checkout, cloudProject, baseCloudSnapshot] = await Promise.all([
			this.#local.status(),
			this.#cloud.project({ projectId: binding.cloudProjectId, actorId: this.#actorId }),
			this.#cloud.readRevision({
				projectId: binding.cloudProjectId,
				actorId: this.#actorId,
				revisionId: binding.lastSyncedCloudRevisionId,
			}),
		]);
		const cloudHeadSnapshot =
			cloudProject.headRevisionId === baseCloudSnapshot.revision.id
				? baseCloudSnapshot
				: await this.#cloud.readRevision({
						projectId: binding.cloudProjectId,
						actorId: this.#actorId,
						revisionId: cloudProject.headRevisionId,
					});
		const baseCloudFiles = cloudFiles(baseCloudSnapshot);
		if (openStoryContentFingerprint(baseCloudFiles) !== binding.lastSyncedContentFingerprint) {
			throw new CloudSyncError(
				"cloud_sync_base_mismatch",
				"Remote binding fingerprint does not match its Cloud base ProjectRevision",
			);
		}
		const localFiles = await this.#local.exportRevision(localProject.headRevisionId);
		const currentCloudFiles = cloudFiles(cloudHeadSnapshot);
		const merged = mergeOpenStoryFiles(baseCloudFiles, localFiles, currentCloudFiles);
		const localChanges = merged.localChanges;
		const cloudChanges = merged.cloudChanges;
		const state: LocalCloudSyncState =
			localChanges.length === 0
				? cloudChanges.length === 0
					? "in_sync"
					: "cloud_ahead"
				: cloudChanges.length === 0
					? "local_ahead"
					: merged.state === "conflict"
						? "conflict"
						: "diverged_mergeable";
		return {
			state,
			dirtyCheckout: checkout.state === "dirty",
			binding,
			localHeadRevisionId: localProject.headRevisionId,
			cloudHeadRevisionId: cloudHeadSnapshot.revision.id,
			localChanges,
			cloudChanges,
			conflicts: merged.state === "conflict" ? merged.conflicts : [],
			baseCloudFiles,
			localFiles,
			cloudFiles: currentCloudFiles,
			...(merged.state === "merged" ? { mergedFiles: merged.files } : {}),
		};
	}

	async #applyLocalTarget(targetFiles: readonly OpenPackageFile[]): Promise<{ id: string; created: boolean }> {
		const localProject = this.#local.project();
		const localFiles = await this.#local.exportRevision(localProject.headRevisionId);
		if (openStoryContentFingerprint(localFiles) === openStoryContentFingerprint(targetFiles)) {
			return { id: localProject.headRevisionId, created: false };
		}
		const base = candidateFromOpenStoryFiles(localFiles, localProject.headRevisionId);
		const next = candidateFromOpenStoryFiles(targetFiles, localProject.headRevisionId);
		const committed = await this.#local.commitManagedChangeSet({
			baseRevisionId: localProject.headRevisionId,
			operations: changeOperationsBetweenCandidates(base, next),
		});
		return { id: committed.id, created: true };
	}

	#publicStatus(analysis: SyncAnalysis): LocalCloudSyncStatus {
		return {
			state: analysis.state,
			dirtyCheckout: analysis.dirtyCheckout,
			binding: { ...analysis.binding },
			localHeadRevisionId: analysis.localHeadRevisionId,
			cloudHeadRevisionId: analysis.cloudHeadRevisionId,
			localChanges: structuredClone(analysis.localChanges),
			cloudChanges: structuredClone(analysis.cloudChanges),
			conflicts: structuredClone(analysis.conflicts),
		};
	}

	#binding(): LocalRemoteBinding {
		const binding = this.#local.remoteBinding();
		if (binding === undefined)
			throw new CloudSyncError("cloud_sync_not_linked", "Local Project is not linked to Cloud");
		if (normalizeEndpoint(binding.endpoint) !== this.#endpoint) {
			throw new CloudSyncError("cloud_sync_endpoint_mismatch", "Remote binding belongs to another Cloud endpoint");
		}
		return binding;
	}

	#requireUnlinked(): void {
		if (this.#local.remoteBinding() !== undefined) {
			throw new CloudSyncError("cloud_sync_already_linked", "Local Project already has a Cloud remote binding");
		}
	}

	#dirtyExcluded(): never {
		throw new CloudSyncError(
			"cloud_sync_dirty_checkout",
			"Open Story Directory has uncommitted changes; explicitly allow pushing/importing only the committed revision",
		);
	}
}
