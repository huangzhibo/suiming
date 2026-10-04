import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitCanonStore } from "../src/artifact/git-canon-store.js";
import { materializeOpenStoryDirectorySnapshot, readOpenStoryDirectory } from "../src/index.js";
import { describeCanonStore } from "./canon-store-contract.js";
import { sampleWorkFiles } from "./sample-work.js";

describeCanonStore("git（ADR-0010）", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-canon-git-"));
	const files = sampleWorkFiles();
	await materializeOpenStoryDirectorySnapshot(root, files);
	const store = new GitCanonStore({ dir: root, now: () => new Date("2026-09-12T00:00:00.000Z") });
	await store.init(files);
	return {
		store,
		projectId: "project-contract",
		close: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
});

test("git Canon 的版本身份只有 id 与 parentId：history 不展开 tree，不随作品变大而变慢", async () => {
	// 多一个字段就是多一次全树读取（packages/runtime/AGENTS.md「Canon、目录与存储」）。这道闸原来只在
	// git-canon-real-work.test 里、要维护者本机的 eval-022 才跑，CI 与别的机器上整条 skip；挪到样例上。
	const root = await mkdtemp(join(tmpdir(), "suiming-canon-shape-"));
	try {
		const files = sampleWorkFiles();
		await materializeOpenStoryDirectorySnapshot(root, files);
		const store = new GitCanonStore({ dir: root, now: () => new Date("2026-09-12T00:00:00.000Z") });
		const genesis = await store.init(files);
		assert.deepEqual(Object.keys(genesis).sort(), ["id", "parentId"]);
		const history = await store.history("project-shape");
		assert.deepEqual(
			history.map((revision) => Object.keys(revision).sort()),
			[["id", "parentId"]],
		);
		assert.deepEqual(Object.keys(await store.readProjectRevision("project-shape", genesis.id)).sort(), [
			"id",
			"parentId",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * 合并策略是作者在自己仓里 `git merge` 时才生效的东西，契约测试碰不到它——那里没有第二条线。
 * 这条钉住两件事：`text/**` 标了 `merge=binary`（两侧都改即冲突，见收敛方案 3.5），以及它是仓库
 * 辅助文件、不进 artifact 快照。
 */
test("git Canon 建仓时写下正文不自动合并的策略，且它不进快照", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-canon-attrs-"));
	try {
		const files = sampleWorkFiles();
		await materializeOpenStoryDirectorySnapshot(root, files);
		const store = new GitCanonStore({ dir: root, now: () => new Date("2026-09-12T00:00:00.000Z") });
		const genesis = await store.init(files);
		const policy = await readFile(join(root, ".gitattributes"), "utf8");
		assert.match(policy, /^text\/\*\* merge=binary$/mu);

		const scanned = await readOpenStoryDirectory(root);
		assert.ok(
			scanned.ignored.some((entry) => entry.path === ".gitattributes" && entry.kind === "repository-auxiliary"),
			".gitattributes 是仓库辅助文件",
		);
		const snapshot = await store.snapshotForProject("project-attrs", genesis.id);
		assert.ok(snapshot.artifacts.every((artifact) => artifact.identity.localId !== ".gitattributes"));

		// 作者自己调过的策略不能被下一次打开覆盖。
		await writeFile(join(root, ".gitattributes"), "# 作者自己的策略\n");
		await store.init(files);
		assert.equal(await readFile(join(root, ".gitattributes"), "utf8"), "# 作者自己的策略\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
