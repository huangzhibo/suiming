import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectCommitCommand } from "../artifact/canon-store.js";
import {
	applyChangeOperations,
	candidateFromStoryFiles,
	changeOperationsBetween,
} from "../artifact/change-operations.js";
import type { RevisionHistoryReader } from "../artifact/derived.js";
import { ArtifactError } from "../artifact/errors.js";
import { artifactIdentityKey, copyArtifactIdentity } from "../artifact/identity.js";
import type { OpenPackageFile } from "../artifact/open-package.js";
import {
	classifyOpenStoryDirectoryFile,
	materializeOpenStoryDirectorySnapshot,
	readOpenStoryDirectory,
	unrecognizedPaths,
} from "../artifact/open-story-directory.js";
import { validateOpenStoryFiles } from "../artifact/open-story-validation.js";
import { ProjectRuntimeSession } from "../artifact/project-runtime-session.js";
import { type IngestSourceInput, ingestSource } from "../artifact/source-ingest.js";
import { type InspectedStoryProject, validateStoryProjectCandidate } from "../artifact/story-design-validator.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import { type StorySearchRequest, type StorySearchResult, searchStoryCandidate } from "../artifact/story-search.js";
import type {
	ArtifactCandidate,
	ArtifactContent,
	ArtifactIdentity,
	CandidateArtifact,
	ChangeOperation,
	ChangeSet,
	ProjectRevision,
} from "../artifact/types.js";
import { InMemoryExecutionState } from "../execution/in-memory-execution-state.js";
import type {
	ExecutionEntities,
	ExecutionEntitySnapshot,
	ExecutionEntityType,
	ExecutionStateDelta,
	ExecutionStateEvent,
	ExecutionStateSnapshot,
	SessionRecord,
	TaskRecord,
} from "../execution/types.js";
import type { SessionEvent } from "../harness/events.js";
import { executionProductEvents } from "../harness/state-events.js";
import { LocalCheckoutSynchronizer } from "./checkout-synchronizer.js";
import { LocalProjectLock, leaseHolderAlive } from "./project-lock.js";
import { scaffoldOpenStoryDirectory } from "./starter-project.js";

/** 并行 `suim` 调用重叠在 open / commit 临界区时的最长等待；超过就是真的有人长期持锁。 */
const PROJECT_LOCK_WAIT_MS = 5_000;

import { GitCanonStore } from "../artifact/git-canon-store.js";
import type { LocalExecutionObject, LocalRemoteBinding } from "./sqlite-local-store.js";
import { type LocalProjectRecord, SqliteLocalStore, type SqliteLocalStoreOptions } from "./sqlite-local-store.js";

/** 作品在本地的当前样子：登记信息来自 SQLite，`headRevisionId` 只来自作品仓的 canon ref。 */
export interface LocalProject extends LocalProjectRecord {
	headRevisionId: string;
}

export interface LocalProjectPaths {
	checkoutPath: string;
	privatePath: string;
	databasePath: string;
	objectRootPath: string;
}

export interface InitLocalProjectInput {
	checkoutPath: string;
	projectId?: string;
}

export interface LocalProjectDiffSide extends ArtifactContent {
	path: string;
	contentSha256: string;
}

export interface LocalProjectDiffEntry {
	kind: "added" | "modified" | "deleted";
	identity: ArtifactIdentity;
	before?: LocalProjectDiffSide;
	after?: LocalProjectDiffSide;
}

export interface LocalProjectDiff {
	projectId: string;
	baseRevisionId: string;
	state: "clean" | "dirty";
	entries: LocalProjectDiffEntry[];
	ignored: Awaited<ReturnType<typeof readOpenStoryDirectory>>["ignored"];
}

export interface LocalProjectCheck {
	projectId: string;
	baseRevisionId: string;
	state: "clean" | "dirty";
	diff: LocalProjectDiff;
	inspection: InspectedStoryProject;
}

export interface LocalProjectCommitResult {
	created: boolean;
	revision: ProjectRevision;
	diff: LocalProjectDiff;
}

export interface LocalRuntimeSessionCommitResult {
	created: boolean;
	revision: ProjectRevision;
}

export type LocalProjectSourceIngestInput = Omit<
	IngestSourceInput,
	"artifactStore" | "projectId" | "projectRevisionId"
>;

export interface LocalProjectSourceIngestResult extends LocalRuntimeSessionCommitResult {
	source: ReturnType<typeof ingestSource>["source"];
}

export interface LocalRevisionFileSide {
	mediaType: string;
	contentSha256: string;
	byteLength: number;
}

export interface LocalRevisionFileChange {
	kind: "added" | "modified" | "deleted";
	path: string;
	before?: LocalRevisionFileSide;
	after?: LocalRevisionFileSide;
}

export interface LocalProjectRollbackResult {
	created: boolean;
	targetRevisionId: string;
	previousHeadRevisionId: string;
	revision: ProjectRevision;
	changes: LocalRevisionFileChange[];
}

export type LocalExecutionStateListener = (event: ExecutionStateEvent) => void;

interface BuiltCheckoutCandidate {
	candidate: ArtifactCandidate;
	diff: LocalProjectDiff;
	changeSet: ChangeSet;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function pathsFor(checkoutPath: string): Promise<LocalProjectPaths> {
	const resolved = resolve(checkoutPath);
	let normalized: string;
	try {
		normalized = await realpath(resolved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		normalized = resolved;
	}
	const privatePath = join(normalized, ".suiming");
	return {
		checkoutPath: normalized,
		privatePath,
		databasePath: join(privatePath, "local.sqlite"),
		objectRootPath: join(privatePath, "objects"),
	};
}

function storeOptions(paths: LocalProjectPaths): SqliteLocalStoreOptions {
	return { databasePath: paths.databasePath, objectRootPath: paths.objectRootPath };
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export class LocalProjectService {
	readonly paths: LocalProjectPaths;
	readonly projectId: string;
	readonly #store: SqliteLocalStore;
	/**
	 * Canon 存储（[ADR-0010](../../../../docs/adr/0010-git-as-canon-storage-engine.md)）。
	 * 已提交的版本化 Story Artifact 在 git 里；SQLite 只留执行数据（Session / Task、事件、
	 * inbox、execution object）与作品-目录绑定。
	 */
	readonly #canon: GitCanonStore;
	#historyCache: { head: string; revisions: ProjectRevision[] } | undefined;
	readonly #digestCache = new Map<string, ReadonlyMap<string, string>>();
	readonly #checkout: LocalCheckoutSynchronizer;
	readonly #executionListeners = new Set<LocalExecutionStateListener>();
	#executionEventSequence = 0;
	#closed = false;
	/**
	 * 最后一次从 canon ref 读到的 Canon，供同步的 `project()` 返回。**它不是真源**：桌面、CLI 与 host 的
	 * `suim commit` 是不同进程里的不同实例，作品锁只锁 open 与 commit 这类短临界区，谁都会推进同一个
	 * ref。原先假设「本服务是 canon ref 的唯一写入者」只缓存不重读，2026-10-01 斗破运行时 CLI 提交到
	 * r7，开着的桌面还停在 r4：已提交的文件标成「候选未提交」，作者在桌面提交会因基线不是当前 Canon
	 * 被拒、直到重开。需要准确 head 的异步操作都先 `refreshHead()`（读 ref 是一次小文件读取）。
	 */
	#head: string;

	private constructor(
		paths: LocalProjectPaths,
		store: SqliteLocalStore,
		canon: GitCanonStore,
		projectId: string,
		head: string,
	) {
		this.paths = paths;
		this.#store = store;
		this.#canon = canon;
		this.projectId = projectId;
		this.#head = head;
		this.#checkout = new LocalCheckoutSynchronizer(paths.checkoutPath);
	}

	/** 作者开工作品：首次登记失败时撤回本次补写的文件；CLI 与桌面共用。 */
	static async initWithStarter(
		input: InitLocalProjectInput & { intent?: string },
	): Promise<{ service: LocalProjectService; written: string[] }> {
		return LocalProjectService.#initialize(input, input);
	}

	static async init(input: InitLocalProjectInput): Promise<LocalProjectService> {
		return (await LocalProjectService.#initialize(input)).service;
	}

	static async #initialize(
		input: InitLocalProjectInput,
		starter?: { intent?: string },
	): Promise<{ service: LocalProjectService; written: string[] }> {
		const paths = await pathsFor(input.checkoutPath);
		if (await exists(paths.databasePath)) {
			throw new ArtifactError(
				"local_project_already_initialized",
				`这里已经初始化过作品，不能重复初始化：${paths.checkoutPath}`,
			);
		}
		// 锁会先建出 .suiming；作品文件不合法时不能把这个空目录留在作者的文件夹里。
		const fresh = !(await exists(paths.privatePath));
		const lock = await LocalProjectLock.acquire(paths.checkoutPath, { waitMs: PROJECT_LOCK_WAIT_MS });
		// 等锁期间另一个入口可能已完成初始化；此时不能写文件或清理对方的登记。
		if (await exists(paths.databasePath)) {
			await lock.release();
			throw new ArtifactError(
				"local_project_already_initialized",
				`这里已经初始化过作品，不能重复初始化：${paths.checkoutPath}`,
			);
		}
		let store: SqliteLocalStore | undefined;
		const written: string[] = [];
		try {
			if (starter !== undefined) await scaffoldOpenStoryDirectory(paths.checkoutPath, starter, written);
			const scanned = await readOpenStoryDirectory(paths.checkoutPath);
			const storyFiles = scanned.files.filter((file) => classifyOpenStoryDirectoryFile(file.path) === "story");
			validateOpenStoryFiles(scanned.files);
			const artifacts = storyFiles.map(
				(file): CandidateArtifact => ({
					identity: storyPackageCodec.identityForPath(file.path),
					path: file.path,
					mediaType: file.mediaType,
					bytes: copyBytes(file.bytes),
				}),
			);
			const unrecognized = unrecognizedPaths(scanned.ignored);
			validateStoryProjectCandidate({
				baseRevisionId: "genesis",
				artifacts,
				...(unrecognized.length === 0 ? {} : { unrecognizedPaths: unrecognized }),
			});
			store = new SqliteLocalStore(storeOptions(paths));
			const projectId = input.projectId?.trim() || `project_${randomUUID()}`;
			store.createProject({ projectId, checkoutPath: paths.checkoutPath });
			// git 仓在作品目录本身：作者看到的就是一个普通 git 仓库，Canon 只是其中一条受保护的 ref。
			const canon = new GitCanonStore({ dir: paths.checkoutPath });
			const genesis = await canon.init(scanned.files);
			const service = new LocalProjectService(paths, store, canon, projectId, genesis.id);
			await lock.release();
			return { service, written };
		} catch (error) {
			store?.close();
			await Promise.all(written.map((file) => rm(join(paths.checkoutPath, file), { force: true })));
			await lock.release();
			if (fresh) await rm(paths.privatePath, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	static async open(checkoutPath: string): Promise<LocalProjectService> {
		const paths = await pathsFor(checkoutPath);
		if (!(await exists(paths.databasePath))) {
			throw new ArtifactError("local_project_not_initialized", `这里还没有初始化作品：${paths.checkoutPath}`);
		}
		const lock = await LocalProjectLock.acquire(paths.checkoutPath, { waitMs: PROJECT_LOCK_WAIT_MS });
		let store: SqliteLocalStore | undefined;
		try {
			store = new SqliteLocalStore(storeOptions(paths));
			const project = store.projectForCheckout(paths.checkoutPath);
			const canon = new GitCanonStore({ dir: paths.checkoutPath });
			let head: string;
			try {
				head = await canon.headRevisionId(project.id);
			} catch (error) {
				if (!(error instanceof ArtifactError && error.code === "project_not_found")) throw error;
				// 已登记但还没有 canon ref：Canon 从 SQLite 换到 git 之前建的作品，或 .git 被丢掉的副本。
				// 两种都按当前 checkout 重建创世版本——切换之前的版本链不跟过来，这是作者 2026-09-12
				// 「现在数据都是测试用的，可以切」时接受的代价。init 只在没有 canon ref 时写，不覆盖历史。
				head = (await canon.init((await readOpenStoryDirectory(paths.checkoutPath)).files)).id;
			}
			const service = new LocalProjectService(paths, store, canon, project.id, head);
			await service.#recoverCheckoutAfterManagedCommit();
			service.#recoverExecutionAfterProcessRestart();
			return service;
		} catch (error) {
			store?.close();
			throw error;
		} finally {
			await lock.release();
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#executionListeners.clear();
		this.#store.close();
		this.#closed = true;
	}

	/** head 是最后一次读到的值；需要准确值的调用方先 `await refreshHead()`。 */
	project(): LocalProject {
		this.#requireOpen();
		// head 只有 canon ref 一个真源：SQLite 只登记「哪个目录是哪个 Project」。
		return { ...this.#store.project(this.projectId), headRevisionId: this.#head };
	}

	/** 从 canon ref 重读当前 Canon；别的进程（CLI、host 的 `suim commit`）可能已经推进了它。 */
	async refreshHead(): Promise<string> {
		this.#requireOpen();
		this.#head = await this.#canon.headRevisionId(this.projectId);
		return this.#head;
	}

	remoteBinding(): LocalRemoteBinding | undefined {
		this.#requireOpen();
		return this.#store.remoteBinding(this.projectId);
	}

	setRemoteBinding(binding: Omit<LocalRemoteBinding, "projectId" | "updatedAt">): LocalRemoteBinding {
		this.#requireOpen();
		return this.#store.setRemoteBinding({ projectId: this.projectId, ...binding });
	}

	clearRemoteBinding(): LocalRemoteBinding | undefined {
		this.#requireOpen();
		return this.#store.clearRemoteBinding(this.projectId);
	}

	async status(): Promise<LocalProjectDiff> {
		return (await this.#buildCheckoutCandidate()).diff;
	}

	async diff(): Promise<LocalProjectDiff> {
		return (await this.#buildCheckoutCandidate()).diff;
	}

	/** 当前 checkout 的候选（可能 dirty）：单 Beat 检查与 impact 查询都在它上面做，不要求先提交。 */
	async checkoutCandidate(): Promise<ArtifactCandidate> {
		return (await this.#buildCheckoutCandidate()).candidate;
	}

	async check(): Promise<LocalProjectCheck> {
		const built = await this.#buildCheckoutCandidate();
		const inspection = validateStoryProjectCandidate(built.candidate);
		return {
			projectId: this.projectId,
			baseRevisionId: built.candidate.baseRevisionId,
			state: built.diff.state,
			diff: built.diff,
			inspection,
		};
	}

	/**
	 * 唯一的提交路径：扫 checkout diff → Checker → 推进 canon ref → 同步 checkout。带 `command` 时
	 * 额外写一条回执，崩溃后 `recoverCommittedAction` 用它认领已经完成的提交，不会重复提交。
	 */
	async commitCheckout(command?: ProjectCommitCommand): Promise<LocalProjectCommitResult> {
		this.#requireOpen();
		const lock = await LocalProjectLock.acquire(this.paths.checkoutPath, { waitMs: PROJECT_LOCK_WAIT_MS });
		try {
			await this.#checkout.recover(await this.refreshHead());
			const built = await this.#buildCheckoutCandidate();
			validateStoryProjectCandidate(built.candidate);
			if (built.changeSet.operations.length === 0) {
				return {
					created: false,
					revision: await this.#canon.readProjectRevision(this.projectId, built.candidate.baseRevisionId),
					diff: built.diff,
				};
			}
			const beforeFiles = await this.#filesForRevision(built.candidate.baseRevisionId);
			const revision = await this.#canon.commit(
				this.projectId,
				built.changeSet,
				validateStoryProjectCandidate,
				command,
			);
			this.#head = revision.id;
			const after = await this.#canon.snapshotForProject(this.projectId, revision.id);
			await this.#checkout.sync(beforeFiles, this.#filesForCandidate(after), revision.id);
			return { created: true, revision, diff: built.diff };
		} finally {
			await lock.release();
		}
	}

	async commitManagedChangeSet(changeSet: ChangeSet): Promise<ProjectRevision> {
		this.#requireOpen();
		const lock = await LocalProjectLock.acquire(this.paths.checkoutPath, { waitMs: PROJECT_LOCK_WAIT_MS });
		try {
			const currentHead = await this.refreshHead();
			await this.#checkout.recover(currentHead);
			const dirty = await this.#buildCheckoutCandidate();
			if (dirty.diff.state !== "clean") {
				throw new ArtifactError("dirty_checkout", "作品目录里有未提交的修改；先提交或放弃它们，再做这一步");
			}
			const beforeFiles = await this.#filesForRevision(currentHead);
			this.#applyChangeSet(dirty.candidate, changeSet);
			const revision = await this.#canon.commit(this.projectId, changeSet, validateStoryProjectCandidate);
			this.#head = revision.id;
			const after = await this.#canon.snapshotForProject(this.projectId, revision.id);
			await this.#checkout.sync(beforeFiles, this.#filesForCandidate(after), revision.id);
			return revision;
		} finally {
			await lock.release();
		}
	}

	/**
	 * 祖先链按 head 缓存。revision 不可变，head 一变就重读——与 `historyReader()` 同一份缓存。
	 * `workspace.show` 每 100ms 刷一次，`readProjectStatus` 每个 turn 开场一次，都只用 `{id, parentId}`。
	 * `ProjectRevision` 瘦身之后 git store 不再为了填清单读整棵 tree，同样的 eval-022
	 * （121 文件 / 21 版本）从 234 ms 降到 5 ms；缓存留着是因为它仍然是每秒十次的查询。
	 */
	async history(): Promise<ProjectRevision[]> {
		this.#requireOpen();
		const head = await this.refreshHead();
		if (this.#historyCache?.head !== head)
			this.#historyCache = { head, revisions: await this.#canon.history(this.projectId) };
		return this.#historyCache.revisions;
	}

	/**
	 * 恢复一个历史快照，但不倒拨 head：目标内容会形成当前 head 的新子 revision。
	 * 这样 session 基线、历史和 remote binding 都保持单调可审计。
	 */
	async rollbackRevision(targetRevisionId: string): Promise<LocalProjectRollbackResult> {
		this.#requireOpen();
		const targetId = targetRevisionId.trim();
		if (targetId.length === 0) throw new ArtifactError("revision_project_mismatch", "Revision id is required");
		const lock = await LocalProjectLock.acquire(this.paths.checkoutPath, { waitMs: PROJECT_LOCK_WAIT_MS });
		try {
			const previousHeadRevisionId = await this.refreshHead();
			await this.#checkout.recover(previousHeadRevisionId);
			const current = await this.#buildCheckoutCandidate();
			if (current.diff.state !== "clean") {
				throw new ArtifactError("dirty_checkout", "回退需要干净的作品目录；先提交或放弃未提交的修改");
			}

			const targetRevision = await this.#canon.readProjectRevision(this.projectId, targetId);
			if (!(await this.#canon.history(this.projectId)).some((revision) => revision.id === targetRevision.id)) {
				throw new ArtifactError(
					"revision_project_mismatch",
					`ProjectRevision ${targetId} is not in the current Project history`,
				);
			}
			const beforeFiles = await this.#filesForRevision(previousHeadRevisionId);
			const targetFiles = await this.#filesForRevision(targetId);
			const changes = this.#revisionFileChanges(beforeFiles, targetFiles);
			if (changes.length === 0) {
				return {
					created: false,
					targetRevisionId: targetId,
					previousHeadRevisionId,
					revision: await this.#canon.readProjectRevision(this.projectId, previousHeadRevisionId),
					changes,
				};
			}

			const target = await this.#canon.snapshotForProject(this.projectId, targetId);
			const revision = await this.#canon.commit(
				this.projectId,
				{
					baseRevisionId: previousHeadRevisionId,
					operations: changeOperationsBetween(current.candidate, target),
				},
				validateStoryProjectCandidate,
			);
			this.#head = revision.id;
			await this.#checkout.sync(beforeFiles, targetFiles, revision.id);
			return { created: true, targetRevisionId: targetId, previousHeadRevisionId, revision, changes };
		} finally {
			await lock.release();
		}
	}

	async search(request: StorySearchRequest, requested?: string): Promise<StorySearchResult> {
		this.#requireOpen();
		const revisionId = requested ?? (await this.refreshHead());
		const candidate = await this.#canon.snapshotForProject(this.projectId, revisionId);
		return searchStoryCandidate(candidate, { kind: "project_revision", projectRevisionId: revisionId }, request);
	}

	async exportRevision(revisionId?: string): Promise<OpenPackageFile[]> {
		this.#requireOpen();
		return this.#filesForRevision(revisionId ?? (await this.refreshHead()));
	}

	/** 某个已提交版本里的一个作品文件；版本里没有它时 undefined。 */
	async readRevisionFile(revisionId: string, path: string): Promise<Uint8Array | undefined> {
		this.#requireOpen();
		return this.#canon.readFile(revisionId, path);
	}

	async materializeRevision(destinationPath: string, revisionId?: string): Promise<void> {
		await materializeOpenStoryDirectorySnapshot(destinationPath, await this.exportRevision(revisionId));
	}

	async saveExecutionObject(mediaType: string, bytes: Uint8Array): Promise<LocalExecutionObject> {
		this.#requireOpen();
		return this.#store.saveExecutionObject(mediaType, bytes);
	}

	async readExecutionObject(id: string): Promise<LocalExecutionObject> {
		this.#requireOpen();
		return this.#store.readExecutionObject(id);
	}

	/**
	 * 派生状态（正文时效、审稿时效、可发布性）的历史读取面。摘要按 revision 缓存——revision 不可变；
	 * 历史与 `history()` 共用按 head 的缓存。
	 */
	historyReader(): RevisionHistoryReader {
		this.#requireOpen();
		return {
			history: () => this.history(),
			fileDigests: async (revisionId) => {
				let digests = this.#digestCache.get(revisionId);
				if (digests === undefined) {
					digests = await this.#canon.fileDigests(this.projectId, revisionId);
					this.#digestCache.set(revisionId, digests);
				}
				return digests;
			},
			snapshot: (revisionId) => this.#canon.snapshotForProject(this.projectId, revisionId),
		};
	}

	loadExecutionState() {
		this.#requireOpen();
		return this.#store.loadExecutionState();
	}

	/** 每条执行命令先持久确认；调用方无需另行保存快照。 */
	createExecutionState(options: { now?: () => Date } = {}): InMemoryExecutionState {
		return new InMemoryExecutionState({
			...options,
			snapshot: this.loadExecutionState(),
			commit: (delta) => this.applyExecutionDelta(delta),
		});
	}

	/** 只读查询用：session 与 task。turn 期间 `workspace.show` 每 100ms 一次，不能每次把全部命令回执读一遍。 */
	loadExecutionEntities(): ExecutionEntities {
		this.#requireOpen();
		return this.#store.loadExecutionEntities();
	}

	subscribeExecutionState(listener: LocalExecutionStateListener): () => void {
		this.#requireOpen();
		this.#executionListeners.add(listener);
		return () => this.#executionListeners.delete(listener);
	}

	/** 产品事件与变更通知都只看这条命令改动的实体：改动前取已持久的那几行，改动后就是写集合本身。 */
	applyExecutionDelta(delta: ExecutionStateDelta): void {
		this.#requireOpen();
		const previous = this.#store.readExecutionEntities(
			delta.changed.map((item) => ({ type: item.type, id: item.record.id })),
		);
		const current: ExecutionEntities = {
			sessions: delta.changed.flatMap((item) => (item.type === "session" ? [item.record as SessionRecord] : [])),
			tasks: delta.changed.flatMap((item) => (item.type === "task" ? [item.record as TaskRecord] : [])),
		};
		this.#store.applyExecutionDelta(delta, executionProductEvents(previous, current));
		this.#emitExecutionChanges(previous, current);
	}

	/** 作者消息持久入队；相同命令返回原回执。 */
	queueInbox(sessionId: string, text: string, commandId?: string, fingerprintInput?: unknown): { sequence: number } {
		this.#requireOpen();
		return this.#store.queueInbox(sessionId, text, commandId, fingerprintInput);
	}

	firstInboxText(sessionId: string): string {
		this.#requireOpen();
		return this.#store.firstInboxText(sessionId);
	}

	readInbox(sessionId: string): { sequence: number; text: string }[] {
		this.#requireOpen();
		return this.#store.readInbox(sessionId);
	}

	appendSessionEvents(events: readonly SessionEvent[], ownerFence?: ExecutionStateSnapshot["ownerFence"]): void {
		this.#requireOpen();
		this.#store.appendSessionEvents(events, ownerFence);
	}

	readSessionEvents(sessionId: string, afterSequence = 0): SessionEvent[] {
		this.#requireOpen();
		return this.#store.readSessionEvents(sessionId, afterSequence);
	}

	async openRuntimeSession(requested?: string): Promise<ProjectRuntimeSession> {
		this.#requireOpen();
		const revisionId = requested ?? (await this.refreshHead());
		return new ProjectRuntimeSession({
			projectId: this.projectId,
			projectRevisionId: revisionId,
			files: await this.#filesForRevision(revisionId),
		});
	}

	async ingestSource(input: LocalProjectSourceIngestInput): Promise<LocalProjectSourceIngestResult> {
		const session = await this.openRuntimeSession();
		const ingested = ingestSource({
			...input,
			artifactStore: session.artifacts,
			projectId: this.projectId,
			projectRevisionId: session.memoryRevisionId,
		});
		const committed = await this.commitRuntimeSession(session);
		return { ...committed, source: ingested.source };
	}

	async recoverCommittedAction(commandId: string): Promise<ProjectRevision | undefined> {
		this.#requireOpen();
		const lock = await LocalProjectLock.acquire(this.paths.checkoutPath, { waitMs: PROJECT_LOCK_WAIT_MS });
		try {
			const revision = await this.#canon.readCommitReceipt(this.projectId, commandId);
			if (!revision) return undefined;
			const head = await this.refreshHead();
			if (head !== revision.id) {
				// 回执证明动作已完成；后来的作者提交不能使它再次执行，也不能倒写 checkout。
				await this.#checkout.recover(head);
				return revision;
			}
			const parentFiles = revision.parentId === null ? [] : await this.#filesForRevision(revision.parentId);
			await this.#checkout.sync(parentFiles, await this.#filesForRevision(revision.id), revision.id);
			return revision;
		} finally {
			await lock.release();
		}
	}

	async commitRuntimeSession(session: ProjectRuntimeSession): Promise<LocalRuntimeSessionCommitResult> {
		this.#requireOpen();
		if (session.projectId !== this.projectId) {
			throw new ArtifactError(
				"project_mismatch",
				`Runtime session belongs to ${session.projectId}, not ${this.projectId}`,
			);
		}
		const localBaseRevisionId = session.projectRevisionId;
		if ((await this.refreshHead()) !== localBaseRevisionId) {
			throw new ArtifactError(
				"revision_conflict",
				`Runtime session is based on ${localBaseRevisionId}; Project head has changed`,
			);
		}
		const files = session.exportFiles();
		validateOpenStoryFiles(files);
		const next: ArtifactCandidate = {
			baseRevisionId: localBaseRevisionId,
			artifacts: files.map((file) => ({
				identity: storyPackageCodec.identityForPath(file.path),
				path: file.path,
				mediaType: file.mediaType,
				bytes: copyBytes(file.bytes),
			})),
		};
		validateStoryProjectCandidate(next);
		const base = await this.#canon.snapshotForProject(this.projectId, localBaseRevisionId);
		const operations = changeOperationsBetween(base, next);
		if (operations.length === 0) {
			return {
				created: false,
				revision: await this.#canon.readProjectRevision(this.projectId, localBaseRevisionId),
			};
		}
		const revision = await this.commitManagedChangeSet({ baseRevisionId: localBaseRevisionId, operations });
		session.advanceProjectRevision(localBaseRevisionId, revision.id);
		return { created: true, revision };
	}

	async #buildCheckoutCandidate(): Promise<BuiltCheckoutCandidate> {
		this.#requireOpen();
		const baseRevisionId = await this.refreshHead();
		const base = await this.#canon.snapshotForProject(this.projectId, baseRevisionId);
		const scanned = await readOpenStoryDirectory(this.paths.checkoutPath);

		const candidate = candidateFromStoryFiles(baseRevisionId, scanned.files, unrecognizedPaths(scanned.ignored));
		const artifacts = candidate.artifacts;

		const baseByIdentity = new Map(
			base.artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]),
		);
		const actualByIdentity = new Map(artifacts.map((artifact) => [artifactIdentityKey(artifact.identity), artifact]));
		const keys = [...new Set([...baseByIdentity.keys(), ...actualByIdentity.keys()])].sort();
		const entries: LocalProjectDiffEntry[] = [];
		const operations: ChangeOperation[] = [];
		for (const key of keys) {
			const before = baseByIdentity.get(key);
			const after = actualByIdentity.get(key);
			if (before === undefined && after !== undefined) {
				entries.push({
					kind: "added",
					identity: copyArtifactIdentity(after.identity),
					after: this.#diffSide(after),
				});
				operations.push({
					operation: "create",
					identity: copyArtifactIdentity(after.identity),
					path: after.path,
					mediaType: after.mediaType,
					bytes: copyBytes(after.bytes),
				});
				continue;
			}
			if (before !== undefined && after === undefined) {
				entries.push({
					kind: "deleted",
					identity: copyArtifactIdentity(before.identity),
					before: this.#diffSide(before),
				});
				operations.push({ operation: "delete", identity: copyArtifactIdentity(before.identity) });
				continue;
			}
			if (before === undefined || after === undefined) continue;
			// 路径变了也是修改：Beat 换卷时内容可以一个字没改。
			if (
				before.path === after.path &&
				before.mediaType === after.mediaType &&
				sha256(before.bytes) === sha256(after.bytes)
			)
				continue;
			entries.push({
				kind: "modified",
				identity: copyArtifactIdentity(after.identity),
				before: this.#diffSide(before),
				after: this.#diffSide(after),
			});
			operations.push({
				operation: "replace",
				identity: copyArtifactIdentity(after.identity),
				path: after.path,
				mediaType: after.mediaType,
				bytes: copyBytes(after.bytes),
			});
		}
		const diff: LocalProjectDiff = {
			projectId: this.projectId,
			baseRevisionId,
			state: entries.length === 0 ? "clean" : "dirty",
			entries,
			ignored: scanned.ignored,
		};
		return { candidate, diff, changeSet: { baseRevisionId, operations } };
	}

	#diffSide(artifact: CandidateArtifact): LocalProjectDiffSide {
		return {
			path: artifact.path,
			mediaType: artifact.mediaType,
			contentSha256: sha256(artifact.bytes),
			bytes: copyBytes(artifact.bytes),
		};
	}

	#filesForCandidate(candidate: ArtifactCandidate): OpenPackageFile[] {
		return candidate.artifacts
			.map((artifact) => ({
				path: artifact.path,
				mediaType: artifact.mediaType,
				bytes: copyBytes(artifact.bytes),
			}))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	async #filesForRevision(revisionId: string): Promise<OpenPackageFile[]> {
		return this.#filesForCandidate(await this.#canon.snapshotForProject(this.projectId, revisionId));
	}

	#applyChangeSet(candidate: ArtifactCandidate, changeSet: ChangeSet): ArtifactCandidate {
		if (candidate.baseRevisionId !== changeSet.baseRevisionId) {
			throw new ArtifactError(
				"revision_conflict",
				`Project head is ${candidate.baseRevisionId}; ChangeSet is based on ${changeSet.baseRevisionId}`,
			);
		}
		return {
			baseRevisionId: candidate.baseRevisionId,
			artifacts: applyChangeOperations(candidate.artifacts, changeSet.operations),
		};
	}

	#sameFiles(left: readonly OpenPackageFile[], right: readonly OpenPackageFile[]): boolean {
		const leftByPath = new Map(left.map((file) => [file.path, `${file.mediaType}\0${sha256(file.bytes)}`]));
		const rightByPath = new Map(right.map((file) => [file.path, `${file.mediaType}\0${sha256(file.bytes)}`]));
		return (
			leftByPath.size === rightByPath.size &&
			[...leftByPath].every(([path, content]) => rightByPath.get(path) === content)
		);
	}

	#revisionFileChanges(
		before: readonly OpenPackageFile[],
		after: readonly OpenPackageFile[],
	): LocalRevisionFileChange[] {
		const beforeByPath = new Map(before.map((file) => [file.path, file]));
		const afterByPath = new Map(after.map((file) => [file.path, file]));
		const side = (file: OpenPackageFile): LocalRevisionFileSide => ({
			mediaType: file.mediaType,
			contentSha256: sha256(file.bytes),
			byteLength: file.bytes.byteLength,
		});
		const changes: LocalRevisionFileChange[] = [];
		for (const path of [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort()) {
			const previous = beforeByPath.get(path);
			const next = afterByPath.get(path);
			if (previous === undefined && next !== undefined) {
				changes.push({ kind: "added", path, after: side(next) });
			} else if (previous !== undefined && next === undefined) {
				changes.push({ kind: "deleted", path, before: side(previous) });
			} else if (
				previous !== undefined &&
				next !== undefined &&
				(previous.mediaType !== next.mediaType || sha256(previous.bytes) !== sha256(next.bytes))
			) {
				changes.push({ kind: "modified", path, before: side(previous), after: side(next) });
			}
		}
		return changes;
	}

	async #recoverCheckoutAfterManagedCommit(): Promise<void> {
		const headId = this.#head;
		if (await this.#checkout.recover(headId)) return;
		const scanned = await readOpenStoryDirectory(this.paths.checkoutPath);
		const currentFiles = scanned.files.filter((file) => classifyOpenStoryDirectoryFile(file.path) === "story");
		const headFiles = await this.#filesForRevision(headId);
		if (this.#sameFiles(currentFiles, headFiles)) return;
		const head = await this.#canon.readProjectRevision(this.projectId, headId);
		if (head.parentId === null) return;
		// Canon 已推进到 head，而 checkout 停在 parent：补完到 head。
		if (!this.#sameFiles(currentFiles, await this.#filesForRevision(head.parentId))) return;
		await this.#checkout.sync(currentFiles, headFiles, headId);
	}

	#recoverExecutionAfterProcessRestart(): void {
		const snapshot = this.#store.loadExecutionState();
		const unfinished = snapshot.sessions
			.filter((session) => session.status === "running")
			.map((session) => `${session.id}@${session.version}`)
			.sort();
		if (unfinished.length === 0) return;
		const execution = this.createExecutionState();
		// 只收敛持有进程已经不在的 session：另一个进程正在跑的不是崩溃遗留，任何 `suim` 调用都不能把它打断。
		execution.recoverUnfinished(`process-restart:${unfinished.join(",")}`, {
			holderAlive: leaseHolderAlive,
		});
	}

	#emitExecutionChanges(previous: ExecutionEntities, current: ExecutionEntities): void {
		if (this.#executionListeners.size === 0) return;
		const before = new Map<string, number>();
		const index = (
			type: ExecutionEntityType,
			entities: readonly ExecutionEntitySnapshot[],
			visit: (type: ExecutionEntityType, entity: ExecutionEntitySnapshot) => void,
		): void => {
			for (const entity of entities) visit(type, entity);
		};
		index("session", previous.sessions, (type, entity) => before.set(`${type}\0${entity.id}`, entity.version));
		index("task", previous.tasks, (type, entity) => before.set(`${type}\0${entity.id}`, entity.version));
		const emit = (entityType: ExecutionEntityType, entity: ExecutionEntitySnapshot): void => {
			if (before.get(`${entityType}\0${entity.id}`) === entity.version) return;
			const event: ExecutionStateEvent = {
				sequence: ++this.#executionEventSequence,
				type: "execution.entity.changed",
				entityType,
				entityId: entity.id,
				snapshot: structuredClone(entity),
			};
			for (const listener of this.#executionListeners) {
				try {
					listener(event);
				} catch {
					// UI projection listeners cannot roll back an already committed execution snapshot.
				}
			}
		};
		index("session", current.sessions, emit);
		index("task", current.tasks, emit);
	}

	#requireOpen(): void {
		if (this.#closed) throw new ArtifactError("local_project_closed", "Local Project service is closed");
	}
}
