import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitCanonStore } from "../src/artifact/git-canon-store.js";
import { readOpenStoryDirectory, validateStoryProjectCandidate } from "../src/index.js";

/**
 * 样例作品只有 2 个 Beat，证不了 git Canon 在真实规模与真实 Design 复杂度下可用。这条在作者的
 * eval-022（69 Beat）上跑：从 git tree 读回的快照必须原样通过 Checker，才说明内容等价。
 * 作品不在本机时跳过——它是作者的数据，不进仓库。
 */
const work = `${process.env.HOME}/stories/eval-022-suiming`;

test("git Canon 在 eval-022 真实作品上可用", { skip: !existsSync(work) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-git-real-"));
	try {
		await cp(work, root, {
			recursive: true,
			filter: (src) => !src.includes("/.suiming") && !src.includes("/.git"),
		});
		const scanned = await readOpenStoryDirectory(root);
		const store = new GitCanonStore({ dir: root });
		const t0 = Date.now();
		const genesis = await store.init(scanned.files);
		console.log(`创世提交 ${Date.now() - t0} ms，${scanned.files.length} 文件`);
		const t1 = Date.now();
		const snapshot = await store.snapshotForProject("p", genesis.id);
		console.log(`读快照 ${Date.now() - t1} ms，${snapshot.artifacts.length} artifact`);
		assert.ok(snapshot.artifacts.length > 100);
		validateStoryProjectCandidate(snapshot);
		console.log("真实 Design 校验通过");
		const t2 = Date.now();
		const history = await store.history("p");
		console.log(`读历史 ${Date.now() - t2} ms，${history.length} 版本`);
		assert.equal(history.length, 1);
		// 版本身份只剩位置：history 不展开 tree，所以它不随作品大小变慢。多一个字段就是多一次全树读取。
		assert.deepEqual(Object.keys(history[0] ?? {}).sort(), ["id", "parentId"]);
		assert.equal(history[0]?.id, genesis.id);
		assert.equal(history[0]?.parentId, null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
