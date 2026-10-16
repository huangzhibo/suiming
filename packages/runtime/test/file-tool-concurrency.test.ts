import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfinedExecutionEnv } from "../src/harness/confined-env.js";
import { fileTools } from "../src/harness/tools.js";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "suiming-file-concurrency-"));
	await writeFile(join(root, "a.md"), "第一段\n第二段\n");
	const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
	const tools = fileTools(env, "write");
	return {
		root,
		env,
		run(name: string, params: Record<string, unknown>) {
			const tool = tools.find((tool) => tool.name === name);
			assert.ok(tool);
			return tool.execute("call", params);
		},
		read: () => readFile(join(root, "a.md"), "utf8"),
		close: () => rm(root, { recursive: true, force: true }),
	};
}

test("Agent 整篇替换：读后作者保存则拒绝旧结果，重读后可继续；新建和自己连续写入仍可用", async () => {
	const f = await fixture();
	try {
		await f.run("read", { path: "./a.md" });
		await writeFile(join(f.root, "a.md"), "作者保存\n");
		await assert.rejects(f.run("write", { path: "a.md", content: "迟到的 Agent 结果\n" }), {
			code: "file_write_conflict",
		});
		assert.equal(await f.read(), "作者保存\n");
		await f.run("read", { path: join(f.root, "a.md") });
		await f.run("write", { path: "a.md", content: "作者保存\nAgent 续写\n" });
		await f.run("write", { path: "a.md", content: "作者保存\nAgent 续写两段\n" });
		assert.equal(await f.read(), "作者保存\nAgent 续写两段\n");
		await f.run("write", { path: "b.md", content: "新文件" });
	} finally {
		await f.close();
	}
});

test("已有文件替换或删除须先读；换轮后旧消息不充当当前版本，读后被外部删除不复活", async () => {
	const f = await fixture();
	try {
		for (const name of ["write", "delete"]) {
			await assert.rejects(f.run(name, { path: "a.md", content: "覆盖" }), { code: "file_read_required" });
		}
		await f.run("read", { path: "a.md" });
		await writeFile(join(f.root, "a.md"), "作者修改");
		await assert.rejects(f.run("delete", { path: "a.md" }), { code: "file_write_conflict" });
		await f.run("read", { path: "a.md" });
		const fresh = fileTools(f.env, "write").find((tool) => tool.name === "write");
		assert.ok(fresh);
		await assert.rejects(fresh.execute("call", { path: "a.md", content: "旧消息中的内容" }), {
			code: "file_read_required",
		});
		await rm(join(f.root, "a.md"));
		await assert.rejects(f.run("write", { path: "a.md", content: "复活旧稿" }), { code: "file_write_conflict" });
		await assert.rejects(f.read(), { code: "ENOENT" });
		await assert.rejects(f.run("read", { path: "a.md" }), { code: "file_not_found" });
		await f.run("write", { path: "a.md", content: "确认删除后重新创建" });
		assert.equal(await f.read(), "确认删除后重新创建");
	} finally {
		await f.close();
	}
});

test("局部 edit 保留作者其他段落，但不会授权用未见过的整篇内容覆盖；同段变化拒绝", async () => {
	const f = await fixture();
	try {
		await f.run("read", { path: "a.md" });
		await writeFile(join(f.root, "a.md"), "第一段\n作者修改第二段\n");
		await f.run("edit", { path: "a.md", oldText: "第一段", newText: "Agent 修改第一段" });
		assert.equal(await f.read(), "Agent 修改第一段\n作者修改第二段\n");
		await assert.rejects(f.run("write", { path: "a.md", content: "Agent 修改第一段\n第二段\n" }), {
			code: "file_read_required",
		});
		await assert.rejects(f.run("edit", { path: "a.md", oldText: "第二段\n不存在", newText: "旧结果" }), {
			code: "edit_not_unique",
		});
	} finally {
		await f.close();
	}
});

test("move 读取后、准备删除前作者改动源文件，不得搬走旧内容再删除新内容", async () => {
	const f = await fixture();
	try {
		const prepare = f.env.prepareWrite.bind(f.env);
		f.env.prepareWrite = async (path, content) => {
			if (path === "a.md" && content === null) await writeFile(join(f.root, "a.md"), "作者最新内容");
			return prepare(path, content);
		};
		await assert.rejects(f.run("move", { from: ["a.md"], to: "b.md" }), { code: "file_write_conflict" });
		assert.equal(await f.read(), "作者最新内容");
		await assert.rejects(readFile(join(f.root, "b.md")), { code: "ENOENT" });
	} finally {
		await f.close();
	}
});

test("copy 覆盖已有不同内容也检查读取版本；目录复制先检查所有目标，冲突不部分覆盖", async () => {
	const f = await fixture();
	try {
		await f.run("write", { path: "source/a.md", content: "源文件" });
		await f.run("write", { path: "source/b.md", content: "源文件乙" });
		await assert.rejects(f.run("copy", { from: "source", to: "." }), { code: "file_read_required" });
		await f.run("read", { path: "a.md" });
		await writeFile(join(f.root, "a.md"), "作者刚保存");
		await assert.rejects(f.run("copy", { from: "source", to: "." }), { code: "file_write_conflict" });
		assert.equal(await f.read(), "作者刚保存");
		await assert.rejects(readFile(join(f.root, "b.md")), { code: "ENOENT" });
		await f.run("read", { path: "a.md" });
		await f.run("copy", { from: "source", to: "." });
		assert.equal(await f.read(), "源文件");
		await f.run("copy", { from: "source", to: "." }); // 同内容不需要再读。
	} finally {
		await f.close();
	}
});

test("读取版本按原始 UTF-8 字节计算，带 BOM 的文件可正常整篇替换", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.root, "a.md"), "\uFEFF正文\n");
		await f.run("read", { path: "a.md" });
		await f.run("write", { path: "a.md", content: "正文补写\n" });
		assert.equal(await f.read(), "正文补写\n");
	} finally {
		await f.close();
	}
});

test("非 UTF-8 文件先确认版本再复制覆盖或删除，不要求模型转录二进制内容", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.root, "a.md"), new Uint8Array([255, 254, 0, 1]));
		await writeFile(join(f.root, "b.bin"), new Uint8Array([255, 0, 2]));
		const result = await f.run("read", { path: "a.md" });
		assert.match(JSON.stringify(result), /非 UTF-8.*4 字节/);
		await f.run("copy", { from: "b.bin", to: "a.md" });
		assert.deepEqual(await readFile(join(f.root, "a.md")), Buffer.from([255, 0, 2]));
		await f.run("read", { path: "a.md" });
		await writeFile(join(f.root, "a.md"), new Uint8Array([255, 0, 3]));
		await assert.rejects(f.run("delete", { path: "a.md" }), { code: "file_write_conflict" });
		await f.run("read", { path: "a.md" });
		await f.run("delete", { path: "a.md" });
		await assert.rejects(f.read(), { code: "ENOENT" });
	} finally {
		await f.close();
	}
});
