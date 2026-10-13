import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
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

test("content-addressed object store 去重并校验内容", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-objects-"));
	try {
		const objects = new ContentAddressedObjectStore(root);
		const keptHash = await objects.put(new Uint8Array([1, 2, 3]));
		assert.equal(await objects.put(new Uint8Array([1, 2, 3])), keptHash);
		assert.deepEqual(await objects.read(keptHash), new Uint8Array([1, 2, 3]));
		await assert.rejects(
			() => objects.read(sha256(new Uint8Array([4, 5, 6]))),
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

test("project lock 带等待：别人释放之后在等待期内拿到，host 并行跑 suim 不必立刻失败", async () => {
	// waitMs 是为 host 同时跑几个 suim 设计的（作品锁只锁 open 与 commit，一瞬间就放）；原来只有超时那条路被测到。
	const root = await mkdtemp(join(tmpdir(), "suiming-project-lock-wait-"));
	try {
		const first = await LocalProjectLock.acquire(root);
		const waiting = LocalProjectLock.acquire(root, { waitMs: 3000 });
		setTimeout(() => void first.release(), 100);
		const second = await waiting;
		await second.release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("project lock 带等待：锁文件刚建好还没写完、或刚被放掉，等的一方照常等，不报「读不出是谁持有」", async () => {
	// 2026-10-07 CI 撞上：持有者在等的一方读文件前一刻放掉了锁，读到 ENOENT 就直接失败，等待期白给了。
	const root = await mkdtemp(join(tmpdir(), "suiming-project-lock-race-"));
	try {
		const lockPath = join(root, ".suiming", "project.lock");
		await mkdir(dirname(lockPath), { recursive: true });
		await writeFile(lockPath, "");
		const waiting = LocalProjectLock.acquire(root, { waitMs: 3000 });
		setTimeout(() => void rm(lockPath), 100);
		await (await waiting).release();
		// 同一时刻抢锁的一串：建文件、写内容、放掉的空档里总有人读到空文件或读不到文件
		await Promise.all(
			Array.from({ length: 20 }, async () => {
				const lock = await LocalProjectLock.acquire(root, { waitMs: 5000 });
				await lock.release();
			}),
		);
		// 一直读不出内容的锁文件（崩在建文件与写内容之间）等到期限照旧报错，由作者处理
		await writeFile(lockPath, "");
		await assert.rejects(LocalProjectLock.acquire(root, { waitMs: 100 }), {
			code: "project_locked",
			message: /读不出是谁持有/u,
		});
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
		execution.addTask({ commandId: "add-task", id: "task-1", sessionId: "session-1", kind: "main", key: "a" });
		execution.recordSessionCheckpoint("checkpoint", "session-1", { kind: "object", id: "checkpoint-object" }, 1);
		store.close();

		store = openStore(fixture);
		const restored = store.createExecutionState({ now: () => new Date("2026-09-03T04:00:00.000Z") });
		assert.deepEqual(restored.session("session-1").checkpointRef, { kind: "object", id: "checkpoint-object" });
		const recovery = restored.recoverUnfinished("recover-after-restart");
		assert.deepEqual(recovery, { recoveredSessionIds: ["session-1"] });
		assert.deepEqual(restored.recoverUnfinished("recover-after-restart"), recovery);
		store.close();

		store = openStore(fixture);
		const twiceRestored = store.createExecutionState();
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

test("SQLite execution object 按内容去重，重启后仍可由 id 读回", async () => {
	const fixture = await createLocalFixture();
	let store: SqliteLocalStore | undefined;
	try {
		store = openStore(fixture);
		const payload = new Uint8Array(70 * 1024).fill(31);
		const first = await store.saveExecutionObject("application/vnd.suiming.test+json", payload);
		const duplicate = await store.saveExecutionObject("application/vnd.suiming.test+json", payload);
		assert.equal(duplicate.id, first.id);
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

test("执行对象回收：只删从 session 与 task 走不到、又早于期限的；有 turn 在跑就不动；被引用却读不出的报出来", async () => {
	// 2026-10-07 三国作品一次长运行后 49,746 个执行对象只有 9,657 个还被引用；没有回收，对象目录只会涨。
	const fixture = await createLocalFixture();
	let clock = new Date("2026-10-01T00:00:00.000Z");
	const store = new SqliteLocalStore({
		databasePath: fixture.databasePath,
		objectRootPath: fixture.objectRootPath,
		inlineTextThresholdBytes: 1024,
		now: () => clock,
	});
	const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
	const save = async (value: unknown, mediaType = "application/vnd.suiming.test+json") =>
		(await store.saveExecutionObject(mediaType, encode(value))).id;
	const exists = async (path: string) =>
		stat(path).then(
			() => true,
			() => false,
		);
	try {
		store.createProject({ projectId: "project-1", checkoutPath: fixture.checkoutPath });
		// 被引用的：checkpoint 经节点引用节点；子任务结果是内联的小 JSON；同样的字节换个媒体类型另存一份当垃圾
		const leaf = await save({ text: "checkpoint 里的消息" });
		const lost = await save({ text: "被引用，字节却丢了" });
		const shared = { text: "两种媒体类型各存一份" };
		const sharedLive = await save(shared);
		const checkpoint = await save({ root: [{ ref: leaf }, { ref: lost }, { ref: sharedLive }] });
		const result = await save({ result: "子任务交回的结果", rounds: [leaf] }, "application/json");
		// 没人引用的
		const garbage = await save({ text: "只有被换掉的旧 checkpoint 引用过" });
		const garbageInline = await save({ text: "没人引用的内联对象" }, "application/json");
		const sharedGarbage = await save(shared, "application/vnd.suiming.other+json");
		const orphanOld = await store.objects.put(encode("没来得及登记就崩了"));
		await utimes(store.objects.pathFor(orphanOld), new Date("2026-09-01"), new Date("2026-09-01"));
		const orphanFresh = await store.objects.put(encode("刚写进目录、还没登记"));
		await rm(store.objects.pathFor(sha256(encode({ text: "被引用，字节却丢了" }))));
		clock = new Date("2026-10-01T05:00:00.000Z");
		const recent = await save({ text: "期限之后写的，还可能有人正要引用" });

		const execution = store.createExecutionState({ now: () => clock });
		execution.createSession({ commandId: "create", id: "session-1", projectId: "project-1" });
		const alive = { ownerId: "owner", pid: process.pid, hostname: hostname(), acquiredAt: clock.toISOString() };
		execution.startTurn({ commandId: "start", sessionId: "session-1", lease: alive });
		execution.recordSessionCheckpoint("checkpoint", "session-1", { kind: "object", id: checkpoint }, 0);
		execution.addTask({ commandId: "task", id: "task-1", sessionId: "session-1", kind: "main", key: "a" });
		execution.completeTask("complete", "task-1", { kind: "object", id: result });

		const before = new Date("2026-10-01T04:00:00.000Z");
		// 本进程有 turn 在跑：一个都不删，也不记作回收过
		assert.deepEqual(await store.collectExecutionObjects({ before }), {
			status: "busy",
			removedObjects: 0,
			removedFiles: 0,
			missing: [],
		});
		assert.equal(store.executionObjectsCollectedAt(), undefined);

		execution.endTurn({ commandId: "end", sessionId: "session-1" });
		const incomplete = await store.collectExecutionObjects({ before });
		assert.equal(incomplete.status, "incomplete");
		assert.deepEqual(incomplete.missing, [lost]);
		assert.equal(incomplete.removedObjects, 0, "引用链不完整时不能继续删");
		assert.equal(store.executionObjectsCollectedAt(), undefined);
		await store.objects.put(encode({ text: "被引用，字节却丢了" }));
		const collected = await store.collectExecutionObjects({ before });
		assert.equal(collected.status, "collected");
		assert.deepEqual(collected.missing, []);
		assert.equal(collected.removedObjects, 3);
		assert.equal(collected.removedFiles, 2, "garbage 一个文件、无人登记的旧文件一个；同字节那份还有人用");
		for (const id of [leaf, sharedLive, checkpoint, result, recent]) await store.readExecutionObject(id);
		for (const id of [garbage, garbageInline, sharedGarbage])
			await assert.rejects(
				() => store.readExecutionObject(id),
				(error: unknown) => error instanceof ArtifactError && error.code === "execution_object_not_found",
			);
		assert.equal(
			await exists(store.objects.pathFor(sha256(encode({ text: "只有被换掉的旧 checkpoint 引用过" })))),
			false,
		);
		assert.equal(await exists(store.objects.pathFor(orphanOld)), false);
		assert.equal(await exists(store.objects.pathFor(orphanFresh)), true);
		assert.equal(store.executionObjectsCollectedAt(), clock.toISOString());

		// 删掉 session：它的 checkpoint 与子任务结果随之成为垃圾
		execution.deleteSession("delete", "session-1");
		clock = new Date("2026-10-02T00:00:00.000Z");
		const afterDelete = await store.collectExecutionObjects({ before: clock });
		assert.equal(afterDelete.status, "collected");
		assert.deepEqual(afterDelete.missing, []);
		assert.equal(afterDelete.removedObjects, 6);
		assert.equal(afterDelete.removedFiles, 5, "内联的结果没有文件");
		for (const id of [leaf, sharedLive, checkpoint, result, recent])
			await assert.rejects(() => store.readExecutionObject(id));
		assert.equal(await exists(store.objects.pathFor(orphanFresh)), true, "目录里的新文件按修改时间留着");
	} finally {
		store.close();
		await cleanupFixture(fixture);
	}
});

test("执行对象回收跑到一半有 turn 开始：还没删的都留着，等下次", async (t) => {
	const fixture = await createLocalFixture();
	const options = { databasePath: fixture.databasePath, objectRootPath: fixture.objectRootPath };
	const store = new SqliteLocalStore(options);
	const other = new SqliteLocalStore(options);
	try {
		store.createProject({ projectId: "project-1", checkoutPath: fixture.checkoutPath });
		const save = async (text: string) =>
			(await store.saveExecutionObject("application/vnd.suiming.test+json", new TextEncoder().encode(text))).id;
		const checkpoint = await save("当前的 checkpoint");
		const garbage = [await save("旧节点一"), await save("旧节点二")];
		const execution = store.createExecutionState();
		execution.createSession({ commandId: "create", id: "session-1", projectId: "project-1" });
		const lease = {
			ownerId: "desktop",
			pid: process.pid,
			hostname: hostname(),
			acquiredAt: new Date().toISOString(),
		};
		execution.startTurn({ commandId: "start-1", sessionId: "session-1", lease });
		execution.recordSessionCheckpoint("checkpoint", "session-1", { kind: "object", id: checkpoint }, 0);
		execution.endTurn({ commandId: "end-1", sessionId: "session-1" });
		// 另一个进程在回收顺着引用走的时候开了 turn
		const read = store.readExecutionObject.bind(store);
		let started = false;
		t.mock.method(store, "readExecutionObject", async (id: string) => {
			if (!started) {
				started = true;
				other.createExecutionState().startTurn({
					commandId: "start-2",
					sessionId: "session-1",
					lease: { ...lease, ownerId: "cli" },
				});
			}
			return read(id);
		});
		const collected = await store.collectExecutionObjects({ before: new Date(Date.now() + 60_000) });
		assert.equal(collected.status, "busy");
		assert.equal(collected.removedObjects, 0);
		t.mock.restoreAll();
		for (const id of garbage) await store.readExecutionObject(id);
		assert.equal(store.executionObjectsCollectedAt(), undefined);
	} finally {
		other.close();
		store.close();
		await cleanupFixture(fixture);
	}
});

test("回收扫描期间另一个 turn 开始又结束，不能按旧引用集合删掉新 checkpoint 复用的节点", async (t) => {
	const fixture = await createLocalFixture();
	let clock = new Date("2026-10-01T00:00:00Z");
	const options = { databasePath: fixture.databasePath, objectRootPath: fixture.objectRootPath, now: () => clock };
	const store = new SqliteLocalStore(options);
	const other = new SqliteLocalStore(options);
	const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
	try {
		store.createProject({ projectId: "project-1", checkoutPath: fixture.checkoutPath });
		const initial = await store.saveExecutionObject("application/json", bytes({ text: "旧恢复点" }));
		const reused = await store.saveExecutionObject("application/json", bytes({ text: "暂时无人引用的旧节点" }));
		const execution = store.createExecutionState({ now: () => clock });
		const lease = { ownerId: "desktop", pid: process.pid, hostname: hostname(), acquiredAt: clock.toISOString() };
		execution.createSession({ commandId: "create", id: "session-1", projectId: "project-1" });
		execution.startTurn({ commandId: "start-1", sessionId: "session-1", lease });
		execution.recordSessionCheckpoint("checkpoint-1", "session-1", { kind: "object", id: initial.id }, 0);
		execution.endTurn({ commandId: "end-1", sessionId: "session-1" });
		clock = new Date("2026-10-02T00:00:00Z");
		const read = store.readExecutionObject.bind(store);
		let injected = false;
		t.mock.method(store, "readExecutionObject", async (id: string) => {
			if (!injected) {
				injected = true;
				const active = other.createExecutionState({ now: () => clock });
				active.startTurn({ commandId: "start-2", sessionId: "session-1", lease });
				await other.saveExecutionObject("application/json", reused.bytes);
				const root = await other.saveExecutionObject("application/json", bytes({ ref: reused.id }));
				active.recordSessionCheckpoint("checkpoint-2", "session-1", { kind: "object", id: root.id }, 0);
				active.endTurn({ commandId: "end-2", sessionId: "session-1" });
			}
			return read(id);
		});
		const result = await store.collectExecutionObjects({ before: new Date("2026-10-01T23:00:00Z") });
		assert.equal(result.status, "busy");
		assert.equal(result.removedObjects, 0);
		assert.deepEqual((await read(reused.id)).bytes, reused.bytes);
		t.mock.restoreAll();
		assert.equal((await store.collectExecutionObjects({ before: clock })).status, "collected");
		await read(reused.id);
	} finally {
		other.close();
		store.close();
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
