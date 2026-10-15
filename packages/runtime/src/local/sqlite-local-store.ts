import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventType } from "@suiming/sdk";
import { canonicalJson, sha256Buffer } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { artifactVersionId, shouldInlineArtifactVersion } from "../artifact/version-storage.js";
import { InMemoryExecutionState } from "../execution/in-memory-execution-state.js";
import type {
	ExecutionCommandReceipt,
	ExecutionEntities,
	ExecutionEntityType,
	ExecutionStateDelta,
	ExecutionStateSnapshot,
	SessionRecord,
	TaskRecord,
} from "../execution/types.js";
import { openActivities, openTextMessages, type SessionEvent } from "../harness/events.js";
import type { ConfirmedStateEvent } from "../harness/state-events.js";
import { ContentAddressedObjectStore } from "./content-addressed-object-store.js";
import { leaseHolderAlive } from "./project-lock.js";

export interface SqliteLocalStoreOptions {
	databasePath: string;
	objectRootPath: string;
	inlineTextThresholdBytes?: number;
	now?: () => Date;
}

export interface LocalProjectRecord {
	id: string;
	checkoutPath: string;
	createdAt: string;
	updatedAt: string;
}

export interface LocalRemoteBinding {
	projectId: string;
	endpoint: string;
	cloudProjectId: string;
	lastSyncedCloudRevisionId: string;
	lastSyncedLocalRevisionId: string;
	lastSyncedContentFingerprint: string;
	updatedAt: string;
}

export interface LocalExecutionObject {
	id: string;
	mediaType: string;
	bytes: Uint8Array;
}

/** 执行对象的字节在落库前先定好内容寻址 id 与存放位置：小文本直接内联，其余进对象目录。 */
interface PreparedPayload {
	id: string;
	mediaType: string;
	contentHash: string;
	byteLength: number;
	inlineBytes: Uint8Array | null;
	objectHash: string | null;
}

export interface ExecutionObjectCollection {
	/** busy：有 turn 在跑（本进程或别的进程），这次没删完（或一个没删），下次再来。 */
	status: "collected" | "busy" | "incomplete";
	removedObjects: number;
	removedFiles: number;
	/** 从 session 与 task 走得到、字节却读不出（丢了或内容变了）的执行对象。 */
	missing: string[];
}

const EXECUTION_OBJECT_ID = /eo_[a-f0-9]{64}/gu;
const COLLECTION_BATCH = 100;

/**
 * 批与批之间让出事件循环：桌面主进程同时在答 IPC，2026-10-07 三国作品第一次回收删了四万个对象，不让出就是 8 秒卡死。
 * 每批 100 个，在写事务里同步删。
 */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function unlinkIfPresent(path: string): number {
	try {
		unlinkSync(path);
		return 1;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0"))
		throw new ArtifactError("invalid_local_store_input", `${label} is invalid`);
	return normalized;
}

function contentFingerprint(value: string): string {
	const normalized = value.trim();
	if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
		throw new ArtifactError("invalid_local_store_input", "remote.lastSyncedContentFingerprint is invalid");
	}
	return normalized;
}

function projectRecord(row: Record<string, unknown>): LocalProjectRecord {
	return {
		id: row.id as string,
		checkoutPath: row.checkout_path as string,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function json<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch (error) {
		throw new ArtifactError("local_store_corrupt", `${label} contains invalid JSON: ${(error as Error).message}`);
	}
}

/**
 * 本地执行存储：Session / Task、事件、inbox、命令回执与执行对象，
 * 外加「哪个目录是哪个 Project」和 Cloud 绑定。
 *
 * **它不再持有 Canon。**已提交的版本化 Story Artifact 全部在作品目录的 git 仓里（`GitCanonStore`，
 * [ADR-0010](../../../../docs/adr/0010-git-as-canon-storage-engine.md)）。曾经的
 * `artifact_versions` / `change_sets` / `project_revisions` / `revision_artifacts` /
 * `revision_evidence_files` 五张表随第 6 步切片 4 一起删除——留着就是第二套 Canon（不变量 3）。
 * `projects.head_revision_id` 同理：head 只有 canon ref 一个真源。
 */
const LOCAL_STORE_SCHEMA_VERSION = 6;

export class SqliteLocalStore {
	readonly databasePath: string;
	readonly objects: ContentAddressedObjectStore;
	readonly #database: DatabaseSync;
	readonly #inlineThreshold: number;
	readonly #now: () => Date;

	constructor(options: SqliteLocalStoreOptions) {
		this.databasePath = nonempty(options.databasePath, "databasePath");
		this.#inlineThreshold = options.inlineTextThresholdBytes ?? 256 * 1024;
		if (!Number.isInteger(this.#inlineThreshold) || this.#inlineThreshold < 0) {
			throw new ArtifactError(
				"invalid_local_store_input",
				"inlineTextThresholdBytes must be a non-negative integer",
			);
		}
		this.#now = options.now ?? (() => new Date());
		mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
		this.objects = new ContentAddressedObjectStore(options.objectRootPath);
		this.#database = new DatabaseSync(this.databasePath, { timeout: 5_000 });
		this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
		this.#migrate();
	}

	close(): void {
		this.#database.close();
	}

	project(projectId: string): LocalProjectRecord {
		const row = this.#database
			.prepare("SELECT id, checkout_path, created_at, updated_at FROM projects WHERE id = ?")
			.get(projectId) as Record<string, unknown> | undefined;
		if (row === undefined) throw new ArtifactError("project_not_found", `Project not found: ${projectId}`);
		return projectRecord(row);
	}

	/**
	 * `.suiming/` 就在作品目录里，数据库的位置即 checkout。目录被移动、改名或复制后登记的路径会过期，
	 * 这时按当前位置重新登记（数据库里只会有这一个 Project），不让作者的作品因为挪了目录就打不开。
	 */
	projectForCheckout(checkoutPath: string): LocalProjectRecord {
		const normalized = nonempty(checkoutPath, "checkoutPath");
		const select = "SELECT id, checkout_path, created_at, updated_at FROM projects";
		let rows = this.#database.prepare(`${select} WHERE checkout_path = ?`).all(normalized) as Record<
			string,
			unknown
		>[];
		if (rows.length === 0) {
			const all = this.#database.prepare(select).all() as Record<string, unknown>[];
			if (all.length === 1) {
				this.#database
					.prepare("UPDATE projects SET checkout_path = ?, updated_at = ? WHERE id = ?")
					.run(normalized, this.#timestamp(), all[0]?.id as string);
				rows = this.#database.prepare(`${select} WHERE checkout_path = ?`).all(normalized) as Record<
					string,
					unknown
				>[];
			}
		}
		if (rows.length === 0) {
			throw new ArtifactError("project_not_found", `No Local Project is registered at ${normalized}`);
		}
		if (rows.length !== 1) {
			throw new ArtifactError("local_store_corrupt", `Multiple Local Projects are registered at ${normalized}`);
		}
		return projectRecord(rows[0] as Record<string, unknown>);
	}

	/** 登记「这个目录是哪个 Project」。作品内容不进这里——创世版本由 `GitCanonStore.init` 写进 canon ref。 */
	createProject(input: { projectId: string; checkoutPath: string }): LocalProjectRecord {
		const projectId = nonempty(input.projectId, "projectId");
		const checkoutPath = nonempty(input.checkoutPath, "checkoutPath");
		if (this.#database.prepare("SELECT 1 AS found FROM projects WHERE id = ?").get(projectId) !== undefined) {
			throw new ArtifactError("project_already_exists", `Project already exists: ${projectId}`);
		}
		const timestamp = this.#timestamp();
		this.#database
			.prepare("INSERT INTO projects (id, checkout_path, created_at, updated_at) VALUES (?, ?, ?, ?)")
			.run(projectId, checkoutPath, timestamp, timestamp);
		return this.project(projectId);
	}

	#assertOwner(fence: ExecutionStateSnapshot["ownerFence"], settled = false): void {
		if (!fence) return;
		const row = this.#database.prepare("SELECT data_json FROM sessions WHERE id = ?").get(fence.sessionId) as
			| { data_json: string }
			| undefined;
		const session = row === undefined ? undefined : json<SessionRecord>(row.data_json, "sessions");
		// turn 收口之后 lease 已释放；事件补发只要求是同一个 turn（turnId 就是那次 lease 的 ownerId）。
		if ((session?.lease?.ownerId ?? (settled ? session?.turnId : undefined)) !== fence.ownerId)
			throw new ArtifactError("session_owner_lost", `session ${fence.sessionId} 的执行权已转移`);
	}

	/**
	 * 一条执行命令的写集合：它改动的实体、删掉的 session 与它自己的回执，同一事务确认。
	 * 成本只与这条命令碰过的实体有关，与项目历史上累积了多少回执无关。
	 */
	applyExecutionDelta(delta: ExecutionStateDelta, events: readonly ConfirmedStateEvent[] = []): void {
		this.#transaction(() => {
			this.#assertOwner(delta.ownerFence);
			this.#assertSingleRunning(delta);
			const replay = this.#receiptPersisted(delta.receipt);
			for (const item of delta.changed) this.#upsertEntity(item.type, item.record, item.baselineVersion, replay);
			for (const id of delta.deletedSessionIds) this.#deleteSessionRows(id);
			this.#insertReceipt(delta.receipt);
			this.#appendConfirmedEvents(events);
		});
	}

	/**
	 * 一个作品同时只有一个 turn 在跑，跨进程也一样：桌面与 suim 各开一个 session 同时跑，会在同一份 checkout 上
	 * 互相覆盖（没有 per-session worktree）。进程内由 LocalSessionController 先拦；进程之间各自的内存状态看不到
	 * 对方，只能在这里查——写事务是 BEGIN IMMEDIATE，两个进程同时开 turn 也只有一个成功。
	 * 持有进程已经不在的 running 是崩溃遗留，不拦，判断与重开时的收敛同一条。
	 */
	#assertSingleRunning(delta: ExecutionStateDelta): void {
		for (const item of delta.changed) {
			if (item.type !== "session") continue;
			const record = item.record as SessionRecord;
			// 只拦有活着的进程来驱动的 turn。
			if (record.status !== "running" || record.lease === undefined || !leaseHolderAlive(record.lease)) continue;
			const rows = this.#database
				.prepare("SELECT data_json FROM sessions WHERE project_id = ? AND status = 'running' AND id <> ?")
				.all(record.projectId, record.id) as { data_json: string }[];
			for (const row of rows) {
				const other = json<SessionRecord>(row.data_json, "sessions");
				if (other.lease === undefined || !leaseHolderAlive(other.lease)) continue;
				throw new ArtifactError(
					"session_running",
					`session ${other.id} 正在跑（桌面或另一个 suim）；一个作品同时只跑一个 turn，等它结束或在那边停下`,
				);
			}
		}
	}

	/** 只读查询用：session 与 task，不读命令回执。 */
	loadExecutionEntities(): ExecutionEntities {
		return this.#transaction(
			() => ({ sessions: this.#records<SessionRecord>("sessions"), tasks: this.#records<TaskRecord>("tasks") }),
			"read",
		);
	}

	/** 按 id 读已持久的实体；不存在的不返回。 */
	readExecutionEntities(keys: readonly { type: ExecutionEntityType; id: string }[]): ExecutionEntities {
		const entities: ExecutionEntities = { sessions: [], tasks: [] };
		for (const key of keys) {
			const table = key.type === "session" ? "sessions" : "tasks";
			const row = this.#database.prepare(`SELECT data_json FROM ${table} WHERE id = ?`).get(key.id) as
				| { data_json: string }
				| undefined;
			if (row === undefined) continue;
			if (key.type === "session") entities.sessions.push(json<SessionRecord>(row.data_json, table));
			else entities.tasks.push(json<TaskRecord>(row.data_json, table));
		}
		return entities;
	}

	#records<T>(table: string): T[] {
		return (
			this.#database.prepare(`SELECT data_json FROM ${table} ORDER BY id`).all() as { data_json: string }[]
		).map((row) => json<T>(row.data_json, table));
	}

	/** 回执已在库里且一致：这条命令的事务提交过、只是确认没回到调用方，允许按原内容重放。不一致是命令冲突。 */
	#receiptPersisted(receipt: ExecutionCommandReceipt): boolean {
		const current = this.#database
			.prepare("SELECT fingerprint, result_json FROM execution_command_receipts WHERE command_id = ?")
			.get(receipt.commandId) as { fingerprint: string; result_json: string } | undefined;
		if (current === undefined) return false;
		if (
			current.fingerprint !== receipt.fingerprint ||
			canonicalJson(json<unknown>(current.result_json, "execution_command_receipts")) !==
				canonicalJson(receipt.result)
		)
			throw new ArtifactError(
				"duplicate_command_conflict",
				`Command ${receipt.commandId} has a different persisted receipt`,
			);
		return true;
	}

	#upsertEntity(
		entityType: ExecutionEntityType,
		record: SessionRecord | TaskRecord,
		baseline: number | undefined,
		replay: boolean,
	): void {
		// 不在写集合的实体不参与竞争；另一个 session 的推进不能阻塞这次独立修改。
		if (record.version === baseline) return;
		const table = entityType === "session" ? "sessions" : "tasks";
		const row = this.#database.prepare(`SELECT data_json FROM ${table} WHERE id = ?`).get(record.id) as
			| { data_json: string }
			| undefined;
		const current = row === undefined ? undefined : json<SessionRecord | TaskRecord>(row.data_json, table);
		// 事务已提交但调用方未收到确认：只有原回执和原内容都一致才允许重放。
		if (replay && current !== undefined && canonicalJson(current) === canonicalJson(record)) return;
		if (current?.version !== baseline || (baseline !== undefined && record.version <= baseline)) {
			throw new ArtifactError(
				"execution_state_conflict",
				`${table} ${record.id} expected version ${baseline ?? "absent"}, found ${current?.version ?? "absent"}`,
			);
		}
		const [secondColumn, secondValue] =
			entityType === "session"
				? ["project_id", (record as SessionRecord).projectId]
				: ["session_id", (record as TaskRecord).sessionId];
		this.#database
			.prepare(
				`INSERT INTO ${table} (id, ${secondColumn}, status, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ${secondColumn} = excluded.${secondColumn}, status = excluded.status, data_json = excluded.data_json`,
			)
			.run(record.id, secondValue, record.status, JSON.stringify(record));
	}

	#deleteSessionRows(id: string): void {
		this.#database.prepare("DELETE FROM session_events WHERE session_id = ?").run(id);
		this.#database.prepare("DELETE FROM session_inbox WHERE session_id = ?").run(id);
		this.#database.prepare("DELETE FROM tasks WHERE session_id = ?").run(id);
		this.#database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
	}

	#insertReceipt(receipt: ExecutionCommandReceipt): void {
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO execution_command_receipts (command_id, fingerprint, result_json) VALUES (?, ?, ?)",
			)
			.run(receipt.commandId, receipt.fingerprint, JSON.stringify(receipt.result));
	}

	#appendConfirmedEvents(events: readonly ConfirmedStateEvent[]): void {
		for (const event of events) {
			const existing = this.#database
				.prepare(
					"SELECT event_json FROM session_events WHERE session_id = ? AND json_extract(event_json, '$.id') = ?",
				)
				.get(event.sessionId, event.id) as { event_json: string } | undefined;
			if (existing) {
				if (
					canonicalJson(json<SessionEvent>(existing.event_json, "session_events").event) !==
					canonicalJson(event.event)
				)
					throw new ArtifactError("session_event_conflict", event.id);
				continue;
			}
			// 强杀、停止或流错误可能没有消息结束事件。与执行状态的收尾在同一事务补齐，
			// 否则官方 AG-UI 客户端拒绝 RUN_FINISHED，桌面会永远重连。只扫描当前 turn。
			if (
				event.event.type === EventType.RUN_FINISHED ||
				event.event.type === EventType.SUBAGENT_FINISHED ||
				event.event.type === EventType.SUBAGENT_ERROR
			) {
				const start = this.#database
					.prepare(
						"SELECT COALESCE(MAX(sequence), 1) AS sequence FROM session_events WHERE session_id = ? AND json_extract(event_json, '$.event.type') = 'RUN_STARTED'",
					)
					.get(event.sessionId) as { sequence: number };
				const current = this.readSessionEvents(event.sessionId, Number(start.sequence) - 1);
				for (const activity of openActivities(current)) {
					if (event.event.type !== EventType.RUN_FINISHED && activity.subagentRunId !== event.event.subagentRunId)
						continue;
					this.#appendConfirmedEvents([
						{
							sessionId: event.sessionId,
							id: `${activity.messageId}:interrupted`,
							event: {
								...activity,
								content: {
									...activity.content,
									status: "interrupted",
									summary: "执行已中断；已有结果保留，未完成动作等待继续",
								},
							},
						},
					]);
				}
				for (const message of openTextMessages(current)) {
					if (event.event.type !== EventType.RUN_FINISHED && message.subagentRunId !== event.event.subagentRunId)
						continue;
					this.#appendConfirmedEvents([
						{
							sessionId: event.sessionId,
							id: `${message.messageId}:end`,
							event: {
								type: EventType.TEXT_MESSAGE_END,
								messageId: message.messageId,
								...(message.metadata === undefined ? {} : { metadata: message.metadata }),
								...(message.subagentRunId === undefined ? {} : { subagentRunId: message.subagentRunId }),
							},
						},
					]);
				}
			}
			const last = this.#database
				.prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM session_events WHERE session_id = ?")
				.get(event.sessionId) as { last: number };
			const envelope: SessionEvent = { ...event, sequence: Number(last.last) + 1, at: this.#timestamp() };
			this.#database
				.prepare("INSERT INTO session_events (session_id, sequence, event_json) VALUES (?, ?, ?)")
				.run(event.sessionId, envelope.sequence, JSON.stringify(envelope));
		}
	}

	/**
	 * 执行命令用的执行状态：session 与 task 读进来，回执不读，重放时按 id 点查（`readCommandReceipt`）。
	 * 回执每条命令一条、从不清理，2026-10-07 三国作品上 9,108 条、9 MB：整份读进来每次约 160 ms，作者发一句话要四次。
	 */
	createExecutionState(
		options: { now?: () => Date; commit?: (delta: ExecutionStateDelta) => void } = {},
	): InMemoryExecutionState {
		return new InMemoryExecutionState({
			...(options.now === undefined ? {} : { now: options.now }),
			snapshot: { schemaVersion: 2, ...this.loadExecutionEntities(), commandReceipts: [] },
			commit: options.commit ?? ((delta) => this.applyExecutionDelta(delta)),
			receipt: (commandId) => this.readCommandReceipt(commandId),
		});
	}

	readCommandReceipt(commandId: string): ExecutionCommandReceipt | undefined {
		const row = this.#database
			.prepare("SELECT fingerprint, result_json FROM execution_command_receipts WHERE command_id = ?")
			.get(commandId) as { fingerprint: string; result_json: string } | undefined;
		return row === undefined
			? undefined
			: {
					commandId,
					fingerprint: row.fingerprint,
					result: json<unknown>(row.result_json, "execution_command_receipts"),
				};
	}

	setRemoteBinding(binding: Omit<LocalRemoteBinding, "updatedAt">): LocalRemoteBinding {
		this.project(binding.projectId);
		const value: LocalRemoteBinding = {
			projectId: binding.projectId,
			endpoint: nonempty(binding.endpoint, "remote.endpoint"),
			cloudProjectId: nonempty(binding.cloudProjectId, "remote.cloudProjectId"),
			lastSyncedCloudRevisionId: nonempty(binding.lastSyncedCloudRevisionId, "remote.lastSyncedCloudRevisionId"),
			lastSyncedLocalRevisionId: nonempty(binding.lastSyncedLocalRevisionId, "remote.lastSyncedLocalRevisionId"),
			lastSyncedContentFingerprint: contentFingerprint(binding.lastSyncedContentFingerprint),
			updatedAt: this.#timestamp(),
		};
		this.#database
			.prepare(
				"INSERT INTO remote_bindings (project_id, endpoint, cloud_project_id, last_synced_cloud_revision_id, last_synced_local_revision_id, last_synced_content_fingerprint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET endpoint = excluded.endpoint, cloud_project_id = excluded.cloud_project_id, last_synced_cloud_revision_id = excluded.last_synced_cloud_revision_id, last_synced_local_revision_id = excluded.last_synced_local_revision_id, last_synced_content_fingerprint = excluded.last_synced_content_fingerprint, updated_at = excluded.updated_at",
			)
			.run(
				value.projectId,
				value.endpoint,
				value.cloudProjectId,
				value.lastSyncedCloudRevisionId,
				value.lastSyncedLocalRevisionId,
				value.lastSyncedContentFingerprint,
				value.updatedAt,
			);
		return value;
	}

	remoteBinding(projectId: string): LocalRemoteBinding | undefined {
		const row = this.#database
			.prepare(
				"SELECT project_id, endpoint, cloud_project_id, last_synced_cloud_revision_id, last_synced_local_revision_id, last_synced_content_fingerprint, updated_at FROM remote_bindings WHERE project_id = ?",
			)
			.get(projectId) as Record<string, unknown> | undefined;
		return row === undefined
			? undefined
			: {
					projectId: row.project_id as string,
					endpoint: row.endpoint as string,
					cloudProjectId: row.cloud_project_id as string,
					lastSyncedCloudRevisionId: row.last_synced_cloud_revision_id as string,
					lastSyncedLocalRevisionId: row.last_synced_local_revision_id as string,
					lastSyncedContentFingerprint: contentFingerprint(row.last_synced_content_fingerprint as string),
					updatedAt: row.updated_at as string,
				};
	}

	clearRemoteBinding(projectId: string): LocalRemoteBinding | undefined {
		this.project(projectId);
		const previous = this.remoteBinding(projectId);
		if (previous !== undefined)
			this.#database.prepare("DELETE FROM remote_bindings WHERE project_id = ?").run(projectId);
		return previous;
	}

	/**
	 * 回收执行对象：从 session 与 task 的 checkpoint、结果出发，顺着内容里出现的 `eo_…` 走一遍，走不到的就是垃圾。
	 * 2026-10-07 三国作品一次长运行后 49,746 个执行对象只有 9,657 个还被引用——每次保存 checkpoint 都换掉一批节点，
	 * 删掉的 session 整个留在库里，没有回收对象目录只会涨。
	 *
	 * 安全靠两条，不靠时间猜：
	 * - 执行对象只在 turn 里写（checkpoint、子任务结果、rank 结果），写完到登记之间、以及 CheckpointArchive 记住「这个节点
	 *   已经存过」的那段时间都在 turn 里；所以有 turn 在跑（本进程或别的进程，lease 持有者还活着）就不删。每一批删除都在
	 *   写事务里重新查一次，并核对扫描开始时的实体版本，连扫描期间已经结束的 turn 也能发现；startTurn 同样要写锁。
	 * - `before` 之后登记的行、修改时间在 `before` 之后的文件当作还有人要，连同它引用的都留着；防的是以后有人在 turn 外写对象。
	 *
	 * 「被引用、字节却读不出」时返回 incomplete 与 missing，停止删除，不把损坏的引用图当完整图。
	 */
	async collectExecutionObjects(options: { before: Date }): Promise<ExecutionObjectCollection> {
		const busy = (removedObjects = 0, removedFiles = 0, missing: string[] = []): ExecutionObjectCollection => ({
			status: "busy",
			removedObjects,
			removedFiles,
			missing,
		});
		if (this.#turnRunning()) return busy();
		const versions = this.#executionVersions();
		const changed = () => this.#turnRunning() || this.#executionVersions() !== versions;
		const cutoff = options.before.toISOString();
		const entities = this.loadExecutionEntities();
		const pending: string[] = [];
		for (const entity of [...entities.sessions, ...entities.tasks])
			for (const ref of [entity.checkpointRef, entity.result]) if (ref !== undefined) pending.push(ref.id);
		for (const row of this.#database
			.prepare("SELECT id FROM execution_objects WHERE created_at >= ?")
			.all(cutoff) as { id: string }[])
			pending.push(row.id);
		const live = new Set<string>();
		const missing: string[] = [];
		while (pending.length > 0) {
			const id = pending.pop() as string;
			if (live.has(id)) continue;
			live.add(id);
			let bytes: Uint8Array;
			try {
				bytes = (await this.readExecutionObject(id)).bytes;
			} catch {
				missing.push(id);
				continue;
			}
			for (const match of Buffer.from(bytes).toString("latin1").matchAll(EXECUTION_OBJECT_ID))
				if (!live.has(match[0])) pending.push(match[0]);
		}
		missing.sort();
		// 引用链断了就无法证明哪些节点是垃圾；保留剩余对象，避免一次丢失继续扩大。
		if (missing.length > 0) return { status: "incomplete", removedObjects: 0, removedFiles: 0, missing };

		const garbage = (
			this.#database.prepare("SELECT id, object_hash FROM execution_objects WHERE created_at < ?").all(cutoff) as {
				id: string;
				object_hash: string | null;
			}[]
		).filter((row) => !live.has(row.id));
		const hashInUse = this.#database.prepare(
			"SELECT 1 AS found FROM execution_objects WHERE object_hash = ? LIMIT 1",
		);
		const remove = this.#database.prepare("DELETE FROM execution_objects WHERE id = ?");
		let removedObjects = 0;
		let removedFiles = 0;
		for (let start = 0; start < garbage.length; start += COLLECTION_BATCH) {
			const batch = garbage.slice(start, start + COLLECTION_BATCH);
			// 删行与删文件在同一个写事务里：turn 开始要写锁，等这一批删完才能开始写对象。文件删除必须同步，
			// 事务期间不能让出事件循环——同一个连接上别的写入会撞上「事务里再开事务」。
			const files = this.#transaction(() => {
				if (changed()) return undefined;
				let files = 0;
				for (const row of batch) {
					remove.run(row.id);
					if (row.object_hash !== null && hashInUse.get(row.object_hash) === undefined)
						files += unlinkIfPresent(this.objects.pathFor(row.object_hash));
				}
				return files;
			});
			if (files === undefined) return busy(removedObjects, removedFiles, missing);
			removedObjects += batch.length;
			removedFiles += files;
			await yieldToEventLoop();
		}

		// 目录里没有行登记的文件：崩在写文件与登记之间留下的，或写到一半的临时文件。
		const orphans = (await this.objects.files()).filter((file) => file.modifiedAt < options.before);
		for (let start = 0; start < orphans.length; start += COLLECTION_BATCH) {
			const batch = orphans.slice(start, start + COLLECTION_BATCH);
			const files = this.#transaction(() => {
				if (changed()) return undefined;
				let files = 0;
				for (const file of batch)
					if (file.hash === undefined || hashInUse.get(file.hash) === undefined)
						files += unlinkIfPresent(file.path);
				return files;
			});
			if (files === undefined) return busy(removedObjects, removedFiles, missing);
			removedFiles += files;
			await yieldToEventLoop();
		}
		const completed = this.#transaction(() => {
			if (changed()) return false;
			this.#database
				.prepare(
					"INSERT INTO local_meta (key, value) VALUES ('execution_objects_collected_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				)
				.run(this.#timestamp());
			return true;
		});
		if (!completed) return busy(removedObjects, removedFiles, missing);
		return { status: "collected", removedObjects, removedFiles, missing };
	}

	/** 引用扫描的边界：哪怕 turn 已经结束，实体版本也会变；复用现有版本，不另存 GC 世代。 */
	#executionVersions(): string {
		return JSON.stringify(
			this.#database
				.prepare(`
			SELECT 'session' AS kind, id, json_extract(data_json, '$.version') AS version FROM sessions
			UNION ALL SELECT 'task' AS kind, id, json_extract(data_json, '$.version') AS version FROM tasks
			ORDER BY kind, id
		`)
				.all(),
		);
	}

	/** 上一次完整跑完执行对象回收的时间；被 turn 打断的不算。 */
	executionObjectsCollectedAt(): string | undefined {
		const row = this.#database
			.prepare("SELECT value FROM local_meta WHERE key = 'execution_objects_collected_at'")
			.get() as { value: string } | undefined;
		return row?.value;
	}

	/** 有没有 turn 在跑：持有进程还活着的 running session（崩溃遗留的不算，它不会再写）。 */
	#turnRunning(): boolean {
		return (
			this.#database.prepare("SELECT data_json FROM sessions WHERE status = 'running'").all() as {
				data_json: string;
			}[]
		).some((row) => {
			const lease = json<SessionRecord>(row.data_json, "sessions").lease;
			return lease !== undefined && leaseHolderAlive(lease);
		});
	}

	async saveExecutionObject(mediaType: string, bytes: Uint8Array): Promise<LocalExecutionObject> {
		const prepared = await this.#preparePayload(mediaType, bytes);
		this.#database
			.prepare(
				"INSERT OR IGNORE INTO execution_objects (id, media_type, content_hash, byte_length, inline_bytes, object_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				prepared.id,
				prepared.mediaType,
				prepared.contentHash,
				prepared.byteLength,
				prepared.inlineBytes,
				prepared.objectHash,
				this.#timestamp(),
			);
		return { id: prepared.id, mediaType: prepared.mediaType, bytes: new Uint8Array(bytes) };
	}

	async readExecutionObject(id: string): Promise<LocalExecutionObject> {
		const row = this.#database
			.prepare("SELECT media_type, content_hash, inline_bytes, object_hash FROM execution_objects WHERE id = ?")
			.get(nonempty(id, "executionObject.id")) as Record<string, unknown> | undefined;
		if (row === undefined) {
			throw new ArtifactError("execution_object_not_found", `Execution object not found: ${id}`);
		}
		const bytes =
			row.object_hash === null
				? new Uint8Array(row.inline_bytes as Uint8Array)
				: await this.objects.read(row.object_hash as string);
		if (sha256Buffer(bytes) !== row.content_hash)
			throw new ArtifactError("local_store_corrupt", `Execution object content changed: ${id}`);
		return { id, mediaType: row.media_type as string, bytes };
	}

	/**
	 * 作者的收件箱：第一条消息和后续补充走同一条通道，根 loop 在 `ready` 阶段第一步取走。
	 * running 排队、idle 由调用方开 turn。
	 */
	queueInbox(sessionId: string, text: string, commandId?: string, fingerprintInput?: unknown): { sequence: number } {
		const value = nonempty(text, "inbox.text");
		// 同一 commandId 换了文本或随行输入（如模型选择）都是冲突，不能静默按原回执放行。
		const fingerprint = sha256Buffer(
			new TextEncoder().encode(
				canonicalJson({ operation: "send", sessionId, text: value, input: fingerprintInput ?? null }),
			),
		);
		return this.#transaction(() => {
			if (commandId !== undefined) {
				const receipt = this.#database
					.prepare("SELECT fingerprint, result_json FROM execution_command_receipts WHERE command_id = ?")
					.get(commandId) as { fingerprint: string; result_json: string } | undefined;
				if (receipt) {
					if (receipt.fingerprint !== fingerprint)
						throw new ArtifactError("command_conflict", "重复命令的消息内容不一致");
					return json<{ sequence: number }>(receipt.result_json, "send receipt");
				}
			}
			const row = this.#database.prepare("SELECT data_json FROM sessions WHERE id = ?").get(sessionId) as
				| { data_json: string }
				| undefined;
			if (!row) throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
			const last = this.#database
				.prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM session_inbox WHERE session_id = ?")
				.get(sessionId) as { last: number };
			const sequence = Number(last.last) + 1;
			this.#database
				.prepare("INSERT INTO session_inbox (session_id, sequence, text, queued_at) VALUES (?, ?, ?, ?)")
				.run(sessionId, sequence, value, this.#timestamp());
			if (commandId !== undefined)
				this.#database
					.prepare(
						"INSERT INTO execution_command_receipts (command_id, fingerprint, result_json) VALUES (?, ?, ?)",
					)
					.run(commandId, fingerprint, JSON.stringify({ sequence }));
			return { sequence };
		});
	}

	/** 对话标题就是作者的第一句话：列表每次刷新都要，只读那一行，不把整个 inbox 读出来。 */
	firstInboxText(sessionId: string): string {
		const row = this.#database
			.prepare("SELECT text FROM session_inbox WHERE session_id = ? ORDER BY sequence LIMIT 1")
			.get(sessionId) as { text: string } | undefined;
		return row?.text ?? "";
	}

	readInbox(sessionId: string): { sequence: number; text: string }[] {
		return this.#database
			.prepare("SELECT sequence, text FROM session_inbox WHERE session_id = ? ORDER BY sequence")
			.all(sessionId) as { sequence: number; text: string }[];
	}

	/** 同一序号只接受完全相同的重放；冲突必须阻止发布，不能静默丢掉另一事件。 */
	appendSessionEvents(events: readonly SessionEvent[], ownerFence?: ExecutionStateSnapshot["ownerFence"]): void {
		if (events.length === 0) return;
		const read = this.#database.prepare(
			"SELECT event_json FROM session_events WHERE session_id = ? AND (sequence = ? OR json_extract(event_json, '$.id') = ?)",
		);
		const statement = this.#database.prepare(
			"INSERT OR IGNORE INTO session_events (session_id, sequence, event_json) VALUES (?, ?, ?)",
		);
		this.#transaction(() => {
			this.#assertOwner(ownerFence, true);
			for (const event of events) {
				const existing = read.get(event.sessionId, event.sequence, event.id) as { event_json: string } | undefined;
				if (
					existing !== undefined &&
					canonicalJson(json<SessionEvent>(existing.event_json, "session_events")) !== canonicalJson(event)
				) {
					throw new ArtifactError(
						"session_event_conflict",
						`session ${event.sessionId} sequence ${event.sequence} already contains another event`,
					);
				}
				statement.run(event.sessionId, event.sequence, JSON.stringify(event));
			}
		});
	}

	readSessionEvents(sessionId: string, afterSequence = 0): SessionEvent[] {
		const rows = this.#database
			.prepare("SELECT event_json FROM session_events WHERE session_id = ? AND sequence > ? ORDER BY sequence")
			.all(nonempty(sessionId, "session.id"), afterSequence) as { event_json: string }[];
		return rows.map((row) => JSON.parse(row.event_json) as SessionEvent);
	}

	/**
	 * 执行对象的 id 沿用内容寻址：`eo_` + sha256(mediaType‖contentHash)，与 `artifactVersionId` 同一
	 * 算法（收敛方案 3.5 决定 5）。同样的字节反复保存得到同一个 id，`INSERT OR IGNORE` 因此天然幂等。
	 */
	async #preparePayload(mediaType: string, bytes: Uint8Array): Promise<PreparedPayload> {
		const normalizedMediaType = nonempty(mediaType, "mediaType");
		const contentHash = sha256Buffer(bytes);
		const inline = shouldInlineArtifactVersion(normalizedMediaType, bytes.byteLength, this.#inlineThreshold);
		return {
			id: `eo_${artifactVersionId(normalizedMediaType, contentHash).slice("av_".length)}`,
			mediaType: normalizedMediaType,
			contentHash,
			byteLength: bytes.byteLength,
			inlineBytes: inline ? new Uint8Array(bytes) : null,
			objectHash: inline ? null : await this.objects.put(bytes),
		};
	}

	#transaction<T>(operation: () => T, mode: "read" | "write" = "write"): T {
		this.#database.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.#database.exec("COMMIT");
			return result;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	#timestamp(): string {
		return this.#now().toISOString();
	}

	/**
	 * 本地执行库只认 v6。v1→v6 的开发期迁移链 2026-10-02 删掉，删前确认在用作品都已是 v6。
	 * 不兼容库在这里就停，不建表、不改版本；保全完整目录后用兼容构建读取，不能以重建执行库冒充迁移。
	 * `local_meta` 是 2026-10-07 随执行对象回收加的：只增一张表，打开 v6 库时补上，旧版本照常读写，所以不升版本。
	 */
	#migrate(): void {
		const hasMeta =
			this.#database
				.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
				.get() !== undefined;
		if (hasMeta) {
			const versions = (
				this.#database.prepare("SELECT version FROM schema_meta ORDER BY version").all() as { version: number }[]
			).map((row) => row.version);
			if (versions.length !== 1 || versions[0] !== LOCAL_STORE_SCHEMA_VERSION)
				throw new ArtifactError(
					"unsupported_local_store_schema",
					`本地执行库 ${this.databasePath} 是 v${versions.join(" / v")}，这一版只认 v${LOCAL_STORE_SCHEMA_VERSION}，不能自动升级。先退出使用此作品的应用和 CLI，完整备份作品目录，包含 .git、.suiming/local.sqlite、可能存在的 SQLite 日志和 .suiming/objects；需要原对话时，用兼容的旧版打开备份副本。若只继续作品，可在另一个完整副本中移出整个 .suiming 后重新打开（或 suim init），接上 git 的 Canon 历史；旧对话不会自动迁入。`,
				);
		}
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS schema_meta (
				version INTEGER PRIMARY KEY
			) STRICT;
			INSERT INTO schema_meta (version)
			SELECT ${LOCAL_STORE_SCHEMA_VERSION}
			WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
			CREATE TABLE IF NOT EXISTS projects (
				id TEXT PRIMARY KEY,
				checkout_path TEXT NOT NULL UNIQUE,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS execution_command_receipts (
				command_id TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				result_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS local_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS execution_objects (
				id TEXT PRIMARY KEY,
				media_type TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				inline_bytes BLOB,
				object_hash TEXT,
				created_at TEXT NOT NULL,
				CHECK ((inline_bytes IS NULL) <> (object_hash IS NULL))
			) STRICT;
			CREATE TABLE IF NOT EXISTS remote_bindings (
				project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
				endpoint TEXT NOT NULL,
				cloud_project_id TEXT NOT NULL,
				last_synced_cloud_revision_id TEXT NOT NULL,
				last_synced_local_revision_id TEXT NOT NULL,
				last_synced_content_fingerprint TEXT NOT NULL,
				updated_at TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id),
				status TEXT NOT NULL,
				data_json TEXT NOT NULL
			) STRICT;
			CREATE INDEX IF NOT EXISTS sessions_project_status ON sessions(project_id, status);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL REFERENCES sessions(id),
				status TEXT NOT NULL,
				data_json TEXT NOT NULL
			) STRICT;
			CREATE INDEX IF NOT EXISTS tasks_session_status ON tasks(session_id, status);
			CREATE TABLE IF NOT EXISTS session_inbox (
				session_id TEXT NOT NULL REFERENCES sessions(id),
				sequence INTEGER NOT NULL,
				text TEXT NOT NULL,
				queued_at TEXT NOT NULL,
				PRIMARY KEY (session_id, sequence)
			) STRICT;
			CREATE TABLE IF NOT EXISTS session_events (
				session_id TEXT NOT NULL REFERENCES sessions(id),
				sequence INTEGER NOT NULL,
				event_json TEXT NOT NULL,
				PRIMARY KEY (session_id, sequence)
			) STRICT;
			CREATE UNIQUE INDEX IF NOT EXISTS session_event_identity ON session_events (session_id, json_extract(event_json, '$.id'));
			CREATE INDEX IF NOT EXISTS execution_objects_object ON execution_objects(object_hash);
		`);
	}
}
