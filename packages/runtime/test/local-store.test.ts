import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	ArtifactError,
	type CandidateArtifact,
	ContentAddressedObjectStore,
	InMemoryExecutionState,
	LocalProjectLock,
	materializeOpenStoryDirectorySnapshot,
	type OpenPackageFile,
	SqliteLocalStore,
	storyPackageCodec,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

interface LocalFixture {
	root: string;
	checkoutPath: string;
	databasePath: string;
	objectRootPath: string;
	files: OpenPackageFile[];
	artifacts: CandidateArtifact[];
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function createLocalFixture(): Promise<LocalFixture> {
	const root = await mkdtemp(join(tmpdir(), "suiming-local-store-"));
	const checkoutPath = join(root, "checkout");
	const files = [
		...sampleWorkFiles(),
		{
			path: "reference/materials/旧案/卷宗.bin",
			mediaType: "application/octet-stream",
			bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
		},
	].sort((left, right) => left.path.localeCompare(right.path));
	await materializeOpenStoryDirectorySnapshot(checkoutPath, files);
	return {
		root,
		checkoutPath,
		databasePath: join(root, "state", "local.sqlite"),
		objectRootPath: join(root, "objects"),
		files,
		artifacts: files.map((file) => ({
			identity: storyPackageCodec.identityForPath(file.path),
			path: file.path,
			mediaType: file.mediaType,
			bytes: file.bytes,
		})),
	};
}

function openStore(fixture: LocalFixture): SqliteLocalStore {
	return new SqliteLocalStore({
		databasePath: fixture.databasePath,
		objectRootPath: fixture.objectRootPath,
		inlineTextThresholdBytes: 64 * 1024,
		now: () => new Date("2026-09-03T02:00:00.000Z"),
	});
}

async function cleanupFixture(fixture: LocalFixture): Promise<void> {
	await rm(fixture.root, { recursive: true, force: true });
}

test("content-addressed object store 去重、校验并回收未引用对象", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-objects-"));
	try {
		const objects = new ContentAddressedObjectStore(root);
		const keptHash = await objects.put(new Uint8Array([1, 2, 3]));
		const removedHash = await objects.put(new Uint8Array([4, 5, 6]));
		assert.equal(await objects.put(new Uint8Array([1, 2, 3])), keptHash);
		assert.deepEqual(await objects.read(keptHash), new Uint8Array([1, 2, 3]));

		const collected = await objects.collect(new Set([keptHash]));
		assert.deepEqual(collected, { kept: [keptHash], removed: [removedHash] });
		await assert.rejects(
			() => objects.read(removedHash),
			(error: unknown) => error instanceof ArtifactError && error.code === "object_not_found",
		);

		await writeFile(objects.pathFor(keptHash), new Uint8Array([9, 9, 9]));
		await assert.rejects(
			() => objects.read(keptHash),
			(error: unknown) => error instanceof ArtifactError && error.code === "object_corrupt",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project lock 拒绝双开、可安全释放并回收本机死进程锁", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-project-lock-"));
	try {
		const first = await LocalProjectLock.acquire(root);
		await assert.rejects(
			() => LocalProjectLock.acquire(root),
			(error: unknown) => error instanceof ArtifactError && error.code === "project_locked",
		);
		await first.release();
		await first.release();

		const lockPath = join(root, ".suiming", "project.lock");
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(
			lockPath,
			`${JSON.stringify({
				version: 1,
				token: "stale-token",
				pid: 2_147_483_647,
				hostname: hostname(),
				createdAt: "2026-09-03T00:00:00.000Z",
			})}\n`,
		);
		const reclaimed = await LocalProjectLock.acquire(root);
		await reclaimed.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("SQLite 本地 Project 登记与 remote binding 跨重启保持", async () => {
	const fixture = await createLocalFixture();
	try {
		let store = openStore(fixture);
		store.createProject({ projectId: "project-1", checkoutPath: fixture.checkoutPath });
		store.setRemoteBinding({
			projectId: "project-1",
			endpoint: "https://cloud.example.invalid",
			cloudProjectId: "cloud-project-1",
			lastSyncedCloudRevisionId: "cloud-revision-1",
			lastSyncedLocalRevisionId: "0".repeat(40),
			lastSyncedContentFingerprint: `sha256:${"a".repeat(64)}`,
		});
		store.close();

		store = openStore(fixture);
		assert.equal(store.project("project-1").checkoutPath, fixture.checkoutPath);
		assert.deepEqual(store.remoteBinding("project-1"), {
			projectId: "project-1",
			endpoint: "https://cloud.example.invalid",
			cloudProjectId: "cloud-project-1",
			lastSyncedCloudRevisionId: "cloud-revision-1",
			lastSyncedLocalRevisionId: "0".repeat(40),
			lastSyncedContentFingerprint: `sha256:${"a".repeat(64)}`,
			updatedAt: "2026-09-03T02:00:00.000Z",
		});
		assert.equal(store.clearRemoteBinding("project-1")?.cloudProjectId, "cloud-project-1");
		assert.equal(store.remoteBinding("project-1"), undefined);
		store.close();
	} finally {
		await cleanupFixture(fixture);
	}
});

test("SQLite execution state 可跨进程恢复，并保留 command idempotency receipt", async () => {
	const fixture = await createLocalFixture();
	try {
		let store = openStore(fixture);
		store.createProject({ projectId: "project-1", checkoutPath: fixture.checkoutPath });
		const execution = new InMemoryExecutionState({
			now: () => new Date("2026-09-03T03:00:00.000Z"),
			commit: (delta) => store.applyExecutionDelta(delta),
		});
		execution.createSession({
			commandId: "create-session",
			id: "session-1",
			projectId: "project-1",
			baseRevisionId: "0".repeat(40),
		});
		execution.startTurn({
			commandId: "start-turn",
			sessionId: "session-1",
			lease: { ownerId: "owner-1", pid: 1, hostname: "elsewhere", acquiredAt: "2026-09-03T03:00:00.000Z" },
		});
		execution.addTask({ commandId: "add-task", id: "task-1", sessionId: "session-1", kind: "subagent", key: "a" });
		execution.recordSessionCheckpoint("checkpoint", "session-1", { kind: "object", id: "checkpoint-object" }, 1);
		store.close();

		store = openStore(fixture);
		const restored = new InMemoryExecutionState({
			now: () => new Date("2026-09-03T04:00:00.000Z"),
			snapshot: store.loadExecutionState(),
			commit: (delta) => store.applyExecutionDelta(delta),
		});
		assert.deepEqual(restored.session("session-1").checkpointRef, { kind: "object", id: "checkpoint-object" });
		const recovery = restored.recoverUnfinished("recover-after-restart");
		assert.deepEqual(recovery, { recoveredSessionIds: ["session-1"] });
		assert.deepEqual(restored.recoverUnfinished("recover-after-restart"), recovery);
		store.close();

		store = openStore(fixture);
		const twiceRestored = new InMemoryExecutionState({ snapshot: store.loadExecutionState() });
		assert.equal(twiceRestored.session("session-1").status, "idle");
		assert.equal(twiceRestored.session("session-1").lastFailure?.code, "process_restart");
		assert.equal(twiceRestored.session("session-1").inboxSequence, 1);
		assert.equal(twiceRestored.task("task-1").status, "interrupted");
		assert.deepEqual(twiceRestored.recoverUnfinished("recover-after-restart"), recovery);
		store.close();
	} finally {
		await cleanupFixture(fixture);
	}
});

test("SQLite execution object 按内容去重，重启与 GC 后仍可由 Task result 引用", async () => {
	const fixture = await createLocalFixture();
	let store: SqliteLocalStore | undefined;
	try {
		store = openStore(fixture);
		const payload = new Uint8Array(70 * 1024).fill(31);
		const first = await store.saveExecutionObject("application/vnd.suiming.test+json", payload);
		const duplicate = await store.saveExecutionObject("application/vnd.suiming.test+json", payload);
		assert.equal(duplicate.id, first.id);
		assert.ok((await store.collectObjects()).kept.includes(sha256(payload)));
		store.close();

		store = openStore(fixture);
		assert.deepEqual(await store.readExecutionObject(first.id), first);
		await assert.rejects(
			() => (store as SqliteLocalStore).readExecutionObject("eo_missing"),
			(error: unknown) => error instanceof ArtifactError && error.code === "execution_object_not_found",
		);
	} finally {
		store?.close();
		await cleanupFixture(fixture);
	}
});

test("SQLite 读取外置执行对象时拒绝磁盘静默损坏", async () => {
	const fixture = await createLocalFixture();
	let store: SqliteLocalStore | undefined;
	try {
		store = openStore(fixture);
		const payload = new Uint8Array(70 * 1024).fill(41);
		const saved = await store.saveExecutionObject("application/octet-stream", payload);
		await writeFile(store.objects.pathFor(sha256(payload)), new Uint8Array([9, 9, 9]));
		await assert.rejects(
			() => (store as SqliteLocalStore).readExecutionObject(saved.id),
			(error: unknown) => error instanceof ArtifactError && error.code === "object_corrupt",
		);
	} finally {
		store?.close();
		await cleanupFixture(fixture);
	}
});
