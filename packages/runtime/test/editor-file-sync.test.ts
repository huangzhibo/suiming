import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EditorFileHandler } from "@suiming/sdk";
import { sha256Hex } from "@suiming/story";
import { ConfinedExecutionEnv } from "../src/harness/confined-env.js";
import { fileTools } from "../src/harness/tools.js";

// 用真实文件与原文件工具验证调用时机；窗口的保存 CAS 与双边合并另由 Electron 验收。
test("按目标同步覆盖 read/write/delete/copy/move，prepare 后的新输入阻止旧结果落盘", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-editor-tools-"));
	const calls: string[] = [];
	const drafts = new Map<string, string>();
	const editorFiles: EditorFileHandler = async (request) => {
		assert.equal(request.operation, "save");
		calls.push(request.path);
		const content = drafts.get(request.path);
		if (content !== undefined) {
			await writeFile(join(root, request.path), content);
			drafts.delete(request.path);
		}
		return null;
	};
	const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write", editorFiles });
	const tools = fileTools(env, "write");
	const run = (name: string, params: Record<string, unknown>) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool);
		return tool.execute("call", params);
	};
	try {
		await writeFile(join(root, "a.md"), "原文");
		await writeFile(join(root, "b.md"), "未触及原文");
		drafts.set("a.md", "作者初稿");
		drafts.set("b.md", "别的半成品");
		await run("list", { path: "." });
		assert.equal(calls.length, 0);
		assert.match(JSON.stringify(await run("read", { path: "a.md" })), /作者初稿/);
		assert.equal(await readFile(join(root, "b.md"), "utf8"), "未触及原文");
		drafts.set("a.md", "作者继续写");
		await assert.rejects(run("write", { path: "a.md", content: "过期替换" }), { code: "file_write_conflict" });
		await run("read", { path: "a.md" });
		const mutation = await env.prepareWrite("a.md", "准备好的结果");
		drafts.set("a.md", "prepare 后的新字");
		await assert.rejects(env.applyMutation(mutation), { code: "file_write_conflict" });
		await run("copy", { from: "a.md", to: "copy.md" });
		assert.equal(await readFile(join(root, "copy.md"), "utf8"), "prepare 后的新字");
		await run("move", { from: ["copy.md"], to: "moved.md" });
		await run("read", { path: "moved.md" });
		await run("delete", { path: "moved.md" });
		assert.ok(!calls.includes("b.md"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("编辑器同步失败回到模型；read/editor 与 write/draftSHA 复用路径和角色权限", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-editor-conflict-"));
	const calls: string[] = [];
	const editorFiles: EditorFileHandler = async (r) => {
		calls.push(r.operation);
		if (r.operation === "save") throw new Error("外部修改，自动保存受阻");
		if (r.operation === "inspect")
			return {
				draft: {
					content: "作者草稿",
					sha256: sha256Hex("作者草稿"),
					baseContent: "原文",
					baseSHA: sha256Hex("原文"),
				},
				file: { content: "外部版本", sha256: sha256Hex("外部版本") },
			};
		assert.equal(r.fileSHA, sha256Hex("外部版本"));
		assert.equal(r.draftSHA, sha256Hex("作者草稿"));
		await writeFile(join(root, r.path), r.content);
		return null;
	};
	const env = new ConfinedExecutionEnv({
		rootPath: root,
		policy: "write",
		editorFiles,
		writable: (p) => p === "a.md",
	});
	const tools = fileTools(env, "write");
	const run = (name: string, params: Record<string, unknown>) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool);
		return tool.execute("call", params);
	};
	try {
		await writeFile(join(root, "a.md"), "外部版本");
		await assert.rejects(run("read", { path: "a.md" }), { code: "editor_sync_failed" });
		const inspected = JSON.stringify(await run("read", { path: "a.md", editor: true }));
		assert.match(inspected, /作者草稿/);
		assert.match(inspected, /外部版本/);
		assert.match(inspected, /原文/);
		await run("write", { path: "a.md", content: "作者草稿与外部版本", draftSHA: sha256Hex("作者草稿") });
		assert.equal(await readFile(join(root, "a.md"), "utf8"), "作者草稿与外部版本");
		const before = calls.length;
		await assert.rejects(
			env.editorFile({
				operation: "resolve",
				path: "b.md",
				content: "不允许",
				draftSHA: "f".repeat(64),
				fileSHA: null,
			}),
			{ code: "permission_denied" },
		);
		await assert.rejects(env.editorFile({ operation: "inspect", path: ".git/config" }), {
			code: "permission_denied",
		});
		assert.equal(calls.length, before);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
