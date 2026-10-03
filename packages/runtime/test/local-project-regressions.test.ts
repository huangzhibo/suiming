import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ArtifactError,
	type ChangeSet,
	composeReviewFile,
	InMemoryExecutionState,
	inspectRelease,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
	publishRelease,
	reviewCurrency,
	reviewsIn,
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
				bytes: encoder.encode("李牧走入皇档。\n\n他在尘封木匣里找到了密信。"),
			},
			{
				operation: "create",
				identity: targetArtifactIdentity("story-text", "beat-0002"),
				path: "text/beat-0002.md",
				mediaType: "text/markdown; charset=utf-8",
				bytes: encoder.encode("天亮前，他公开真相，亲手把唯一的密信送进火里。"),
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

		await writeFile(join(checkoutPath, "text", "beat-0001.md"), "李牧走入皇档。\n\n他找到了密信，并且犹豫了。");
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

test("host 修改一章正文只让审查该章的审稿失效，其余审稿与正文时效保留；审稿文件本身留在版本里", async () => {
	const { root, checkoutPath } = await smokeCheckout();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath, projectId: "partial-review" });
		await writeAllText(service);
		const written = await headCandidate(service);
		const reviewBeat = (beatId: string, now: Date) =>
			composeReviewFile(written.candidate, {
				layer: "text",
				scope: { kind: "beats", storyBeatIds: [beatId] },
				revision: written.head,
				draft: { verdict: "pass", summary: beatId, findings: [], uncovered: [], uncertainties: [] },
				now,
			});
		const firstReview = reviewBeat("beat-0001", new Date("2026-09-13T10:00:00Z"));
		const secondReview = reviewBeat("beat-0002", new Date("2026-09-13T10:00:01Z"));
		await service.commitManagedChangeSet({
			baseRevisionId: written.head,
			operations: [firstReview, secondReview].map((review) => ({
				operation: "create",
				identity: targetArtifactIdentity("review", review.id),
				path: `review/${review.id}.md`,
				mediaType: "text/markdown; charset=utf-8",
				bytes: encoder.encode(review.content),
			})),
		});

		await writeFile(
			join(checkoutPath, "text", "beat-0002.md"),
			"天亮前，他公开真相，亲手把密信送进火里。人群沉默许久。",
		);
		const committed = await service.commitCheckout();
		assert.equal(committed.created, true);

		const after = await headCandidate(service);
		const reviews = new Map(reviewsIn(after.candidate).map((item) => [item.id, item]));
		assert.deepEqual([...reviews.keys()].sort(), [firstReview.id, secondReview.id].sort(), "审稿文件不随失效消失");
		assert.deepEqual(
			await reviewCurrency(after.reader, after.head, after.candidate, reviews.get(firstReview.id) as never),
			{
				state: "current",
				changed: [],
				revision: written.head,
			},
		);
		assert.deepEqual(
			await reviewCurrency(after.reader, after.head, after.candidate, reviews.get(secondReview.id) as never),
			{
				state: "stale",
				changed: ["text/beat-0002.md"],
				revision: written.head,
			},
		);
		assert.deepEqual(
			(await textCurrencies(after.reader, after.head, after.candidate)).map((entry) => [
				entry.storyBeatId,
				entry.state,
			]),
			[
				["beat-0001", "current"],
				["beat-0002", "current"],
			],
		);
	} finally {
		service?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("执行状态按行保存：另一进程新增的 session 不被抹掉，版本落后的写入报告冲突", async () => {
	const { root, checkoutPath } = await smokeCheckout();
	let first: SqliteLocalStore | undefined;
	let second: SqliteLocalStore | undefined;
	try {
		const service = await LocalProjectService.init({ checkoutPath, projectId: "two-processes" });
		const paths = service.paths;
		const genesis = service.project().headRevisionId;
		service.close();
		const options = { databasePath: paths.databasePath, objectRootPath: paths.objectRootPath };
		first = new SqliteLocalStore(options);
		second = new SqliteLocalStore(options);
		// 走产品的写入路径：每条命令只写自己改动的行（applyExecutionDelta）。2026-10-02 之前这条测试走的是
		// 整份快照写入，那条路产品早已不用，测试守的不是产品。
		const a = new InMemoryExecutionState({
			snapshot: first.loadExecutionState(),
			commit: (delta) => first?.applyExecutionDelta(delta),
		});
		const b = new InMemoryExecutionState({
			snapshot: second.loadExecutionState(),
			commit: (delta) => second?.applyExecutionDelta(delta),
		});
		const lease = { ownerId: "owner", pid: 1, hostname: "elsewhere", acquiredAt: new Date().toISOString() };

		a.createSession({ commandId: "a:session", id: "session-a", projectId: "two-processes", baseRevisionId: genesis });
		b.createSession({ commandId: "b:session", id: "session-b", projectId: "two-processes", baseRevisionId: genesis });

		const merged = first.loadExecutionState();
		assert.deepEqual(merged.sessions.map((session) => session.id).sort(), ["session-a", "session-b"]);

		// A 推进了 session-a；B 持有 session-a 的旧版本再写入时必须报告冲突，而不是覆盖。
		a.startTurn({ commandId: "a:start", sessionId: "session-a", lease });
		const stale = new InMemoryExecutionState({
			snapshot: merged,
			commit: (delta) => second?.applyExecutionDelta(delta),
		});
		assert.throws(
			() =>
				stale.startTurn({
					commandId: "b:start-stale",
					sessionId: "session-a",
					lease: { ...lease, ownerId: "other" },
				}),
			(error: unknown) => error instanceof ArtifactError && error.code === "execution_state_conflict",
		);
		const current = new InMemoryExecutionState({ snapshot: first.loadExecutionState() }).session("session-a");
		assert.equal(current.status, "running");
		assert.equal(current.lease?.ownerId, "owner");
	} finally {
		first?.close();
		second?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Beat 文件与 index 对不上时 status / diff 仍可读，check 回到模型手里而不是抛异常", async () => {
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
			"---\nsubjects:\n  character: [李牧]\n---\n新写的一节。\n",
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
		const moved = await active.diff();
		assert.deepEqual(
			moved.entries.map((entry) => [entry.kind, entry.identity.localId, entry.after?.path]),
			[["modified", "beat-0002", "outline/story/vol-0009/beat-0002.md"]],
		);
		await assert.rejects(
			() => active.check(),
			(error: unknown) => (error as { code?: string }).code === "invalid_story_outline",
		);
		assert.equal(service.project().headRevisionId.length > 0, true);
	} finally {
		service?.close();
		await rm(fixture.root, { recursive: true, force: true });
	}
});
