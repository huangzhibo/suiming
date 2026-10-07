import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { GitCanonStore } from "../src/artifact/git-canon-store.js";
import {
	ArtifactError,
	composeReviewFile,
	InMemoryExecutionState,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
	type OpenPackageFile,
	readOpenStoryDirectory,
	reviewCurrency,
	reviewsIn,
	SqliteLocalStore,
	targetArtifactIdentity,
	textCurrencies,
	validateStoryProjectCandidate,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface ServiceFixture {
	root: string;
	checkoutPath: string;
	files: OpenPackageFile[];
}

async function createServiceFixture(): Promise<ServiceFixture> {
	const root = await mkdtemp(join(tmpdir(), "suiming-local-service-"));
	const checkoutPath = join(root, "checkout");
	await materializeOpenStoryDirectorySnapshot(checkoutPath, sampleWorkFiles());
	await writeFile(join(checkoutPath, "README.md"), "# Repository auxiliary\n");
	return { root, checkoutPath, files: sampleWorkFiles() };
}

async function cleanup(fixture: ServiceFixture): Promise<void> {
	await rm(fixture.root, { recursive: true, force: true });
}

function byPath(files: readonly OpenPackageFile[]): Map<string, string> {
	return new Map(files.map((file) => [file.path, `${file.mediaType}:${Buffer.from(file.bytes).toString("base64")}`]));
}

test("Local Project application service 从真实 checkout 计算、检查并提交 host diff", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const genesis = service.project().headRevisionId;
		assert.equal((await service.status()).state, "clean");

		const beatPath = join(fixture.checkoutPath, "outline", "story", "vol-0001", "beat-0002.md");
		const beat = decoder.decode(await readFile(beatPath));
		await writeFile(beatPath, beat.replace("各船同时点火", "二十艘船同时点火"));

		const diff = await service.status();
		assert.equal(diff.state, "dirty");
		assert.equal(diff.baseRevisionId, genesis);
		assert.deepEqual(
			diff.entries.map((entry) => [entry.kind, entry.before?.path, entry.after?.path]),
			[["modified", "outline/story/vol-0001/beat-0002.md", "outline/story/vol-0001/beat-0002.md"]],
		);
		assert.equal((await service.check()).inspection.check.state.passed, true);

		const committed = await service.commitCheckout();
		assert.equal(committed.created, true);
		assert.equal(committed.revision.parentId, genesis);
		assert.equal((await service.status()).state, "clean");
		assert.equal((await service.commitCheckout()).created, false);
		service.close();

		service = await LocalProjectService.open(fixture.checkoutPath);
		assert.equal((await service.history()).length, 2);
		assert.equal(service.project().headRevisionId, committed.revision.id);
		assert.equal(decoder.decode(await readFile(join(fixture.checkoutPath, "README.md"))), "# Repository auxiliary\n");

		const exported = await service.exportRevision();
		const destination = join(fixture.root, "exported");
		await service.materializeRevision(destination);
		assert.deepEqual(byPath((await readOpenStoryDirectory(destination)).files), byPath(exported));
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("另一个进程推进了 Canon：本实例读状态、提交都以当前 Canon 为基线，不停在自己打开时的版本", async () => {
	// 2026-10-01 斗破真实运行：CLI 提交到 r7，开着的桌面还停在 r4，把已提交的文件标成「候选未提交」；
	// 作者此时在桌面提交，会因基线不是当前 Canon 被拒，直到重开作品。桌面、CLI 与 host 的 suim commit
	// 是不同进程里的不同实例，作品锁只锁 open 与 commit，谁都不是 canon ref 的唯一写入者。
	const fixture = await createServiceFixture();
	let desktop: LocalProjectService | undefined;
	let cli: LocalProjectService | undefined;
	try {
		desktop = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		cli = await LocalProjectService.open(fixture.checkoutPath);
		const beatPath = join(fixture.checkoutPath, "outline", "story", "vol-0001", "beat-0002.md");
		const beat = decoder.decode(await readFile(beatPath));
		await writeFile(beatPath, beat.replace("各船同时点火", "二十艘船同时点火"));
		const elsewhere = await cli.commitCheckout();
		assert.equal(elsewhere.created, true);

		const status = await desktop.status();
		assert.equal(status.state, "clean");
		assert.equal(status.baseRevisionId, elsewhere.revision.id);
		assert.equal(desktop.project().headRevisionId, elsewhere.revision.id);

		await writeFile(beatPath, beat.replace("各船同时点火", "各船一齐点火"));
		const mine = await desktop.commitCheckout();
		assert.equal(mine.created, true);
		assert.equal(mine.revision.parentId, elsewhere.revision.id);
	} finally {
		cli?.close();
		desktop?.close();
		await cleanup(fixture);
	}
});

test("Local Project 将 symlink 与系统 canonical path 归一为同一 checkout identity", async () => {
	const fixture = await createServiceFixture();
	const aliasPath = join(fixture.root, "checkout-alias");
	let service: LocalProjectService | undefined;
	try {
		await symlink(fixture.checkoutPath, aliasPath, "dir");
		service = await LocalProjectService.init({ checkoutPath: aliasPath, projectId: "project-canonical-path" });
		assert.equal(service.paths.checkoutPath, await realpath(fixture.checkoutPath));
		service.close();
		service = await LocalProjectService.open(fixture.checkoutPath);
		assert.equal(service.projectId, "project-canonical-path");
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("revision rollback 从当前 head 创建恢复 revision，并准确恢复历史作品文件", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-rollback" });
		const activeService = service;
		const targetRevisionId = service.project().headRevisionId;
		const targetFiles = await service.exportRevision(targetRevisionId);
		const changed = await service.commitManagedChangeSet({
			baseRevisionId: targetRevisionId,
			operations: [
				{
					operation: "replace",
					identity: targetArtifactIdentity("character", "黄盖"),
					path: "world/characters/黄盖.md",
					mediaType: "text/markdown; charset=utf-8",
					bytes: encoder.encode("---\nname: 黄盖\n---\n这是回退前的临时人物版本。\n"),
				},
			],
		});
		const rolledBack = await service.rollbackRevision(targetRevisionId);
		assert.equal(rolledBack.created, true);
		assert.equal(rolledBack.previousHeadRevisionId, changed.id);
		assert.equal(rolledBack.revision.parentId, changed.id);
		assert.equal(rolledBack.targetRevisionId, targetRevisionId);
		assert.ok(rolledBack.changes.some((change) => change.path === "world/characters/黄盖.md"));
		assert.deepEqual(byPath(await service.exportRevision()), byPath(targetFiles));
		assert.deepEqual(byPath((await readOpenStoryDirectory(fixture.checkoutPath)).files), byPath(targetFiles));
		assert.equal((await service.history()).length, 3);

		const noOp = await service.rollbackRevision(rolledBack.revision.id);
		assert.equal(noOp.created, false);
		assert.equal(noOp.revision.id, rolledBack.revision.id);
		assert.deepEqual(noOp.changes, []);

		const characterPath = join(fixture.checkoutPath, "world", "characters", "黄盖.md");
		await writeFile(characterPath, `${await readFile(characterPath, "utf8")}未提交候选。\n`);
		await assert.rejects(
			() => activeService.rollbackRevision(targetRevisionId),
			(error: unknown) => error instanceof ArtifactError && error.code === "dirty_checkout",
		);
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("host 提交 StoryText 后正文时效从 git 历史派生：Design 闭包没变是 current，改了闭包里的文件就是 design-changed，重开也一样", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		await mkdir(join(fixture.checkoutPath, "text"), { recursive: true });
		await writeFile(join(fixture.checkoutPath, "text", "beat-0001.md"), "黄盖走入赤壁，在木匣中找到火船。\n");
		await writeFile(join(fixture.checkoutPath, "text", "beat-0002.md"), "约定那夜，二十艘火船一齐点火，直冲曹营。\n");
		const committed = await service.commitCheckout();
		assert.equal(committed.created, true);
		const currencies = async (project: LocalProjectService) => {
			const reader = project.historyReader();
			const head = project.project().headRevisionId;
			return textCurrencies(reader, head, await reader.snapshot(head));
		};
		assert.deepEqual(await currencies(service), [
			{ storyBeatId: "beat-0001", state: "current", writtenAt: committed.revision.id, changed: [] },
			{ storyBeatId: "beat-0002", state: "current", writtenAt: committed.revision.id, changed: [] },
		]);

		service.close();
		service = await LocalProjectService.open(fixture.checkoutPath);
		assert.ok((await currencies(service)).every((entry) => entry.state === "current"));

		await writeFile(
			join(fixture.checkoutPath, "world", "characters", "黄盖.md"),
			"---\nname: 黄盖\n---\n宁可自己受刑，也不让计谋露出破绽。\n",
		);
		await service.commitCheckout();
		assert.deepEqual(
			(await currencies(service)).map((entry) => [entry.state, entry.writtenAt, entry.changed]),
			[
				["design-changed", committed.revision.id, ["world/characters/黄盖.md"]],
				["design-changed", committed.revision.id, ["world/characters/黄盖.md"]],
			],
		);
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});
test("host 换卷是改 index 加 mv 两步，diff 里两个 artifact 都算改过", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const indexPath = join(fixture.checkoutPath, "outline", "story", "index.yaml");
		await writeFile(
			indexPath,
			"schema_version: 2\nvolumes:\n  - id: vol-0001\n    title: 赤壁之战\n    beat_ids: [beat-0001]\n  - id: vol-0002\n    title: 余波\n    beat_ids: [beat-0002]\n",
		);
		const from = join(fixture.checkoutPath, "outline", "story", "vol-0001", "beat-0002.md");
		const to = join(fixture.checkoutPath, "outline", "story", "vol-0002", "beat-0002.md");
		await mkdir(dirname(to), { recursive: true });
		await rename(from, to);

		const diff = await service.status();
		// 文件挪了位置、内容一个字没改，也是这个 artifact 变了：路径是事实，不是从 index 推出来的。
		assert.deepEqual(
			diff.entries.map((entry) => [entry.kind, entry.identity.kind, entry.identity.localId]),
			[
				["modified", "story-beat", "beat-0002"],
				["modified", "story-index", "main"],
			],
		);
		const beatEntry = diff.entries.find((entry) => entry.identity.kind === "story-beat");
		assert.equal(beatEntry?.before?.path, "outline/story/vol-0001/beat-0002.md");
		assert.equal(beatEntry?.after?.path, "outline/story/vol-0002/beat-0002.md");
		await service.commitCheckout();
		assert.equal((await service.status()).state, "clean");
		assert.equal(decoder.decode(await readFile(to)).includes("各船同时点火"), true);
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("非法 host candidate 不推进 ProjectRevision，Agent 也不能覆盖 dirty checkout", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const activeService = service;
		const genesis = service.project().headRevisionId;
		const characterPath = join(fixture.checkoutPath, "world", "characters", "黄盖.md");
		await writeFile(characterPath, "---\nname: 黄盖\nfamily:\n  parent: [不存在的人]\n---\n错误引用。\n");
		await assert.rejects(() => activeService.check());
		await assert.rejects(() => activeService.commitCheckout());
		assert.equal(service.project().headRevisionId, genesis);

		await assert.rejects(
			() =>
				activeService.commitManagedChangeSet({
					baseRevisionId: genesis,
					operations: [
						{
							operation: "replace",
							identity: targetArtifactIdentity("character", "黄盖"),
							path: "world/characters/黄盖.md",
							mediaType: "text/markdown; charset=utf-8",
							bytes: encoder.encode("---\nname: 黄盖\n---\nAgent candidate。\n"),
						},
					],
				}),
			(error: unknown) => error instanceof ArtifactError && error.code === "dirty_checkout",
		);
		assert.equal(decoder.decode(await readFile(characterPath)).includes("不存在的人"), true);
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("Story 根下放错路径的文件：状态与 diff 照常读得出来并点名它，check 与 commit 拒绝，挪走之后照常提交", async () => {
	// 2026-10-01 斗破那一轮：Agent 写了 world/secrets/x.md，扫描直接抛错，整部作品连 session list 都读不出来。
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const activeService = service;
		const genesis = service.project().headRevisionId;
		const stray = join(fixture.checkoutPath, "world", "secrets", "secret-x.md");
		await mkdir(dirname(stray), { recursive: true });
		await writeFile(stray, "# 一个秘密\n");
		await writeFile(join(fixture.checkoutPath, "world", "characters", "黄盖.md"), "---\nname: 黄盖\n---\n改过。\n");

		const status = await service.status();
		assert.equal(status.state, "dirty");
		assert.deepEqual(
			status.ignored.filter((entry) => entry.kind === "unrecognized"),
			[{ path: "world/secrets/secret-x.md", kind: "unrecognized" }],
		);
		const unrecognized = (error: unknown) =>
			error instanceof ArtifactError &&
			error.code === "unsupported_story_package_path" &&
			error.message.includes("world/secrets/secret-x.md");
		await assert.rejects(() => activeService.check(), unrecognized);
		await assert.rejects(() => activeService.commitCheckout(), unrecognized);
		assert.equal(service.project().headRevisionId, genesis);

		await rm(dirname(stray), { recursive: true });
		const committed = await service.commitCheckout();
		assert.equal(committed.created, true);
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("Agent managed ChangeSet 原子回写 checkout，且保留仓库辅助文件", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const genesis = service.project().headRevisionId;
		const revision = await service.commitManagedChangeSet({
			baseRevisionId: genesis,
			operations: [
				{
					operation: "replace",
					identity: targetArtifactIdentity("character", "黄盖"),
					path: "world/characters/黄盖.md",
					mediaType: "text/markdown; charset=utf-8",
					bytes: encoder.encode("---\nname: 黄盖\n---\n宁可自己受刑，也不让计谋露出破绽，事后也认这顿打。\n"),
				},
			],
		});
		assert.equal(revision.parentId, genesis);
		assert.equal((await service.status()).state, "clean");
		assert.equal(
			decoder
				.decode(await readFile(join(fixture.checkoutPath, "world", "characters", "黄盖.md")))
				.includes("这顿打"),
			true,
		);
		assert.equal(decoder.decode(await readFile(join(fixture.checkoutPath, "README.md"))), "# Repository auxiliary\n");
		await assert.rejects(() => readFile(join(fixture.checkoutPath, ".suiming", "checkout-write.json")));
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("open 能恢复数据库已提交但 checkout 尚未 materialize 的崩溃窗口", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const paths = service.paths;
		const genesis = service.project().headRevisionId;
		service.close();
		service = undefined;

		// 绕过 service 直接推进 Canon，模拟「canon ref 已移、checkout 还没同步」的崩溃窗口。
		const canon = new GitCanonStore({ dir: paths.checkoutPath });
		const committed = await canon.commit(
			"project-1",
			{
				baseRevisionId: genesis,
				operations: [
					{
						operation: "replace",
						identity: targetArtifactIdentity("character", "黄盖"),
						path: "world/characters/黄盖.md",
						mediaType: "text/markdown; charset=utf-8",
						bytes: encoder.encode("---\nname: 黄盖\n---\n崩溃恢复后的权威人物版本。\n"),
					},
				],
			},
			validateStoryProjectCandidate,
		);
		assert.equal(
			decoder
				.decode(await readFile(join(fixture.checkoutPath, "world", "characters", "黄盖.md")))
				.includes("崩溃恢复后的权威人物版本"),
			false,
		);

		service = await LocalProjectService.open(fixture.checkoutPath);
		assert.equal(service.project().headRevisionId, committed.id);
		assert.equal((await service.status()).state, "clean");
		assert.equal(
			decoder
				.decode(await readFile(join(fixture.checkoutPath, "world", "characters", "黄盖.md")))
				.includes("崩溃恢复后的权威人物版本"),
			true,
		);
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("open 只收敛持有进程已死的 running session：回 idle 记 process_restart，子任务标 interrupted", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const paths = service.paths;
		const genesis = service.project().headRevisionId;
		service.close();
		service = undefined;

		const store = new SqliteLocalStore({ databasePath: paths.databasePath, objectRootPath: paths.objectRootPath });
		const execution = new InMemoryExecutionState({ commit: (delta) => store.applyExecutionDelta(delta) });
		execution.createSession({
			commandId: "session:create",
			id: "session-1",
			projectId: "project-1",
			baseRevisionId: genesis,
		});
		execution.startTurn({
			commandId: "turn:start",
			sessionId: "session-1",
			lease: { ownerId: "owner-1", pid: 1, hostname: "elsewhere", acquiredAt: new Date().toISOString() },
		});
		execution.addTask({ commandId: "task:add", id: "task-1", sessionId: "session-1", kind: "main", key: "a" });
		execution.createSession({
			commandId: "session:create:2",
			id: "session-2",
			projectId: "project-1",
			baseRevisionId: genesis,
		});
		execution.startTurn({
			commandId: "turn:start:2",
			sessionId: "session-2",
			lease: { ownerId: "owner-2", pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() },
		});
		store.close();

		service = await LocalProjectService.open(fixture.checkoutPath);
		const recovered = service.loadExecutionEntities();
		const dead = recovered.sessions.find((session) => session.id === "session-1");
		assert.equal(dead?.status, "idle");
		assert.equal(dead?.lease, undefined);
		assert.equal(dead?.lastFailure?.code, "process_restart");
		assert.equal(recovered.tasks[0]?.status, "interrupted");
		const alive = recovered.sessions.find((session) => session.id === "session-2");
		assert.equal(alive?.status, "running", "本机还活着的进程持有的 session 不是崩溃遗留");
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});

test("canon ref 丢了（例如 .git 被删）时 open 拒绝，不把没过 Checker 的 checkout 写成新的创世版本", async () => {
	// 2026-10-04 审查发现：open 曾在这里按当前 checkout 直接建 Canon，绕过 Checker。
	const fixture = await createServiceFixture();
	try {
		const service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		service.close();
		await rm(join(fixture.checkoutPath, ".git"), { recursive: true, force: true });
		const characterPath = join(fixture.checkoutPath, "world", "characters", "黄盖.md");
		await writeFile(characterPath, "---\nname: 黄盖\nfamily:\n  parent: [不存在的人]\n---\n错误引用。\n");

		await assert.rejects(
			LocalProjectService.open(fixture.checkoutPath),
			(error: unknown) =>
				error instanceof ArtifactError &&
				error.code === "local_project_canon_missing" &&
				error.message.includes(".suiming/local.sqlite"),
		);
		await assert.rejects(readFile(join(fixture.checkoutPath, ".git", "HEAD")), { code: "ENOENT" });

		// 照提示挪走执行库后走 init：非法 checkout 被 Checker 拒绝，改好了才建出新的创世版本。
		await rename(join(fixture.checkoutPath, ".suiming", "local.sqlite"), join(fixture.root, "local.sqlite.bak"));
		await assert.rejects(LocalProjectService.init({ checkoutPath: fixture.checkoutPath }));
		await writeFile(characterPath, "---\nname: 黄盖\n---\n改好了。\n");
		const reinitialized = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath });
		assert.equal((await reinitialized.status()).state, "clean");
		reinitialized.close();
	} finally {
		await cleanup(fixture);
	}
});

test("审稿文件与作品变更同一次提交；重开后审稿从版本快照读回并按历史判时效", async () => {
	const fixture = await createServiceFixture();
	let service: LocalProjectService | undefined;
	try {
		service = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "project-1" });
		const genesis = service.project().headRevisionId;
		const review = composeReviewFile(await service.historyReader().snapshot(genesis), {
			layer: "design",
			scope: { kind: "book" },
			revision: genesis,
			draft: {
				verdict: "pass",
				summary: "更新后的 Design 检查通过。",
				findings: [],
				uncovered: [],
				uncertainties: [],
			},
		});
		await writeFile(
			join(fixture.checkoutPath, "world", "characters", "黄盖.md"),
			"---\nname: 黄盖\n---\n宁可自己受刑，也不让计谋露出破绽，并愿意事后认下这顿打。\n",
		);
		await mkdir(join(fixture.checkoutPath, "review"), { recursive: true });
		await writeFile(join(fixture.checkoutPath, review.path), review.content);

		const committed = await service.commitCheckout();
		assert.equal(committed.created, true);
		assert.deepEqual(committed.diff.entries.map((entry) => [entry.kind, entry.identity.kind]).sort(), [
			["added", "review"],
			["modified", "character"],
		]);
		assert.equal((await service.commitCheckout()).created, false);
		const exported = await service.exportRevision(committed.revision.id);
		assert.ok(exported.some((file) => file.path === review.path));

		service.close();
		service = await LocalProjectService.open(fixture.checkoutPath);
		const reader = service.historyReader();
		const head = service.project().headRevisionId;
		const candidate = await reader.snapshot(head);
		const restored = reviewsIn(candidate);
		assert.deepEqual(
			restored.map((item) => [item.id, item.file.draft.verdict, item.file.revision]),
			[[review.id, "pass", genesis]],
		);
		// 审的是 genesis，head 多了一次 Design 修改：审稿已 stale，changed 点名是哪个文件。
		assert.deepEqual(await reviewCurrency(reader, head, candidate, restored[0] as never), {
			state: "stale",
			changed: ["world/characters/黄盖.md"],
			revision: genesis,
		});
	} finally {
		service?.close();
		await cleanup(fixture);
	}
});
test("作品目录移动或改名后，Local Project 按当前位置重新登记，历史不丢", async () => {
	const fixture = await createServiceFixture();
	try {
		const initial = await LocalProjectService.init({ checkoutPath: fixture.checkoutPath, projectId: "moved" });
		const headRevisionId = initial.project().headRevisionId;
		initial.close();
		const movedPath = join(fixture.root, "moved-checkout");
		await rename(fixture.checkoutPath, movedPath);

		const reopened = await LocalProjectService.open(movedPath);
		try {
			assert.equal(reopened.projectId, "moved");
			assert.equal(reopened.project().checkoutPath, await realpath(movedPath));
			assert.equal(reopened.project().headRevisionId, headRevisionId);
			assert.equal((await reopened.status()).state, "clean");
			assert.equal((await reopened.history()).length, 1);
		} finally {
			reopened.close();
		}
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("init 校验失败不留下 .suiming：锁建出的目录随失败收回，已有的 .suiming 不动", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-local-init-fail-"));
	try {
		await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
		await mkdir(join(root, "source/source_old"), { recursive: true });
		await writeFile(join(root, "source/source_old/source.yaml"), "schema_version: 3\nsource_id: old\n");
		await writeFile(join(root, "source/source_old/original.bin"), "旧材料\n");
		await writeFile(join(root, "source/source_old/material.txt"), "旧材料\n");
		await assert.rejects(LocalProjectService.init({ checkoutPath: root }), { code: "invalid_document" });
		await assert.rejects(readFile(join(root, ".suiming")), { code: "ENOENT" });
		// 作者自己已有 .suiming（例如放了别的东西）时不删。
		await mkdir(join(root, ".suiming"));
		await writeFile(join(root, ".suiming/keep.txt"), "mine\n");
		await assert.rejects(LocalProjectService.init({ checkoutPath: root }), { code: "invalid_document" });
		assert.equal(await readFile(join(root, ".suiming/keep.txt"), "utf8"), "mine\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
