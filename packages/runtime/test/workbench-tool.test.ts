import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkbenchContext } from "@suiming/sdk";
import { ConfinedExecutionEnv } from "../src/harness/confined-env.js";
import { workbenchTools } from "../src/harness/workbench-tool.js";

test("界面能力仅桌面声明，导航沿用文件边界，不保存候选或借界面绕过路径保护", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-ui-tool-"));
	let calls = 0;
	let saves = 0;
	const env = new ConfinedExecutionEnv({
		rootPath: root,
		policy: "write",
		editorFiles: async () => {
			saves++;
			return null;
		},
	});
	const context: WorkbenchContext = {
		location: "one",
		active: { page: "file:甲.md", title: "甲", path: "甲.md", view: "read", unsaved: false },
		openDocuments: [],
		openDocumentCount: 0,
	};
	try {
		await writeFile(join(root, "甲.md"), "原文");
		await symlink(tmpdir(), join(root, "outside"));
		assert.deepEqual(workbenchTools(undefined, env), []);
		const tool = workbenchTools(async () => {
			calls++;
			return structuredClone(context);
		}, env)[0];
		assert.ok(tool);
		for (const path of ["../escape.md", ".git/config", ".codex/instructions.md", "outside/other.md"])
			await assert.rejects(
				tool.execute("x", { action: "open", path, expectedLocation: "one" }),
				/permission_denied/,
			);
		assert.equal(calls, 0);
		await tool.execute("x", { action: "open", path: "甲.md", expectedLocation: "one" });
		assert.equal(calls, 1);
		assert.equal(saves, 0);
		await assert.rejects(tool.execute("x", { action: "open", path: "甲.md" }), /expectedLocation/);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(tool.execute("x", { action: "context" }, controller.signal));
		assert.equal(calls, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
