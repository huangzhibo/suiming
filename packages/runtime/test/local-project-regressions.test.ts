import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ArtifactError,
	type ChangeSet,
	inspectRelease,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
	publishRelease,
	SqliteLocalStore,
	targetArtifactIdentity,
	textCurrencies,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();

async function smokeCheckout(): Promise<{ root: string; checkoutPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "suiming-regression-"));
	const checkoutPath = join(root, "checkout");
	await materializeOpenStoryDirectorySnapshot(checkoutPath, sampleWorkFiles());
	return { root, checkoutPath };
}

async function writeAllText(service: LocalProjectService): Promise<void> {
	const write: ChangeSet = {
		baseRevisionId: service.project().headRevisionId,
		operations: [
			{
				operation: "create",
				identity: targetArtifactIdentity("story-text", "beat-0001"),
				path: "text/beat-0001.md",
				mediaType: "text/markdown; charset=utf-8",
				bytes: encoder.encode("黄盖当众挨了军杖。\n\n他一声没吭。"),
			},
			{
				operation: "create",
				identity: targetArtifactIdentity("story-text", "beat-0002"),
				path: "text/beat-0002.md",
				mediaType: "text/markdown; charset=utf-8",
				bytes: encoder.encode("约定那夜，二十艘火船一齐点火，冲进了曹营。"),
			},
		],
	};
	await service.commitManagedChangeSet(write);
}

async function headCandidate(service: LocalProjectService) {
	const reader = service.historyReader();
	const head = service.project().headRevisionId;
	return { reader, head, candidate: await reader.snapshot(head) };
}

test("发布 Release 后 host 修改正文仍能提交，Release 只变为 stale", async () => {
	const { root, checkoutPath } = await smokeCheckout();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath, projectId: "release-edit" });
		await writeAllText(service);
		const before = await headCandidate(service);
		const published = await publishRelease(before.reader, {
			candidate: before.candidate,
			headRevisionId: before.head,
		});
		await service.commitManagedChangeSet({ baseRevisionId: before.head, operations: published.operations });
		assert.ok((await service.exportRevision()).some((file) => file.path === "release/manifest.yaml"));

		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "黄盖当众挨了军杖。\n\n他找到了火船，并且犹豫了。");
		const committed = await service.commitCheckout();
		assert.equal(committed.created, true);
		assert.equal((await service.status()).state, "clean");
		// Release 文件留在 revision 里，但不再 current。
		assert.ok((await service.exportRevision()).some((file) => file.path === "release/manifest.yaml"));
		const after = await headCandidate(service);
		assert.equal((await inspectRelease(after.reader, after.head, after.candidate)).state, "stale");
		// 正文时效仍在：作者只需重新审稿、重新发布，而不是重写每一章。
		assert.ok(
			(await textCurrencies(after.reader, after.head, after.candidate)).every((entry) => entry.state === "current"),
		);
	} finally {
		service?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("同一作品同时只有一个 running session，跨进程也一样；持有进程已经不在的 running 是崩溃遗留，不拦", async () => {
	const { root, checkoutPath } = await smokeCheckout();
	let first: SqliteLocalStore | undefined;
	let second: SqliteLocalStore | undefined;
	try {
		const service = await LocalProjectService.init({ checkoutPath, projectId: "one-turn" });
		const paths = service.paths;
		const genesis = service.project().headRevisionId;
		service.close();
		// 两个 store 打开同一个库，就是桌面与 suim 两个进程：各自的内存状态只看得到自己开库时的样子。
		const options = { databasePath: paths.databasePath, objectRootPath: paths.objectRootPath };
		first = new SqliteLocalStore(options);
		second = new SqliteLocalStore(options);
		const desktop = first.createExecutionState();
		desktop.createSession({
			commandId: "a:session",
			id: "session-a",
			projectId: "one-turn",
			baseRevisionId: genesis,
		});
		const cli = second.createExecutionState();
		cli.createSession({ commandId: "b:session", id: "session-b", projectId: "one-turn", baseRevisionId: genesis });
		const alive = {
			ownerId: "desktop",
			pid: process.pid,
			hostname: hostname(),
			acquiredAt: new Date().toISOString(),
		};
		desktop.startTurn({ commandId: "a:start", sessionId: "session-a", lease: alive });

		assert.throws(
			() => cli.startTurn({ commandId: "b:start", sessionId: "session-b", lease: { ...alive, ownerId: "cli" } }),
			(error: unknown) =>
				error instanceof ArtifactError && error.code === "session_running" && error.message.includes("session-a"),
		);
		assert.equal(second.createExecutionState().session("session-b").status, "idle");

		// 桌面那一轮结束后，命令行就能开。
		desktop.endTurn({ commandId: "a:end", sessionId: "session-a" });
		const retry = second.createExecutionState();
		retry.startTurn({ commandId: "b:start-2", sessionId: "session-b", lease: { ...alive, ownerId: "cli" } });
		retry.endTurn({ commandId: "b:end", sessionId: "session-b" });

		// 崩溃遗留：session-a 还标着 running，持有进程已经不在了，不挡别的 session。
		const crashed = first.createExecutionState();
		crashed.startTurn({
			commandId: "a:start-2",
			sessionId: "session-a",
			lease: { ...alive, ownerId: "dead", pid: 2 ** 22 + 17 },
		});
		const after = second.createExecutionState();
		after.startTurn({ commandId: "b:start-3", sessionId: "session-b", lease: { ...alive, ownerId: "cli" } });
		assert.equal(after.session("session-b").status, "running");
	} finally {
		first?.close();
		second?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Beat 文件与 index 对不上时 status / diff 仍可读，check 以带出路的诊断拒绝（在 Agent 里就是回到模型手里的拒绝）", async () => {
	// 2026-09-14 之前：路径由 outline/story/index.yaml 反推，扫描阶段一发现文件不在投影位置就抛
	// ArtifactError。后果是新写一个还没写进 index 的 Beat 文件，status / diff 与 turn 开场一起炸——
	// 不是 Checker 拒绝回到模型手里，是整个工作区读不出来。
	const fixture = await smokeCheckout();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const active = service;

		// ① 新建了一个 index 还没列的 Beat 文件
		await mkdir(join(fixture.checkoutPath, "outline", "story", "vol-0001"), { recursive: true });
		await writeFile(
			join(fixture.checkoutPath, "outline", "story", "vol-0001", "beat-0003.md"),
			"---\nsubjects:\n  character: [黄盖]\n---\n新写的一节。\n",
		);
		const added = await active.status();
		assert.equal(added.state, "dirty");
		assert.deepEqual(
			added.entries.map((entry) => [entry.kind, entry.identity.localId]),
			[["added", "beat-0003"]],
		);
		await assert.rejects(
			() => active.check(),
			(error: unknown) => {
				const diagnostics = (error as { diagnostics?: readonly { hint?: string }[] }).diagnostics ?? [];
				return (
					(error as { code?: string }).code === "invalid_story_outline" &&
					diagnostics.some((item) => /把 beat-0003 加进卷 vol-0001/u.test(item.hint ?? ""))
				);
			},
		);

		// ② 把一个 Beat 挪到 index 没说的卷目录里
		await rm(join(fixture.checkoutPath, "outline", "story", "vol-0001", "beat-0003.md"));
		await mkdir(join(fixture.checkoutPath, "outline", "story", "vol-0009"), { recursive: true });
		await rename(
			join(fixture.checkoutPath, "outline", "story", "vol-0001", "beat-0002.md"),
			join(fixture.checkoutPath, "outline", "story", "vol-0009", "beat-0002.md"),
		);
		const moved = await active.status();
		assert.deepEqual(
			moved.entries.map((entry) => [entry.kind, entry.identity.localId, entry.after?.path]),
			[["modified", "beat-0002", "outline/story/vol-0009/beat-0002.md"]],
		);
		await assert.rejects(
			() => active.check(),
			(error: unknown) => (error as { code?: string }).code === "invalid_story_outline",
		);
	} finally {
		service?.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});
