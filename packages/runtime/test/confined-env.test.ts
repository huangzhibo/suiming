import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { ConfinedExecutionEnv } from "../src/index.js";

async function sandbox(): Promise<{ root: string; outside: string }> {
	const base = await mkdtemp(join(tmpdir(), "suiming-confined-"));
	const root = join(base, "checkout");
	const outside = join(base, "outside");
	await mkdir(join(root, "intent"), { recursive: true });
	await mkdir(join(root, "evidence"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(root, "intent", "a.md"), "intent\n");
	await writeFile(join(root, "evidence", "manifest.json"), "{}\n");
	await writeFile(join(outside, "secret.txt"), "secret\n");
	return { root, outside };
}

test("受限环境：路径逃逸、symlink 与只读策略都被拒绝，没有 shell", async () => {
	const { root, outside } = await sandbox();
	try {
		const write = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		assert.equal(await write.readTextFile("intent/a.md"), "intent\n");
		await write.writeFile("intent/b.md", "b\n");
		assert.equal(await write.readTextFile("intent/b.md"), "b\n");
		for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "~/anything"]) {
			await assert.rejects(write.readTextFile(path), { code: "permission_denied" });
		}
		await symlink(outside, join(root, "world"));
		await assert.rejects(write.readTextFile("world/secret.txt"), /Symlinks/u);
		// 整个 checkout 可写（脚本、笔记都行），只有 .git / .suiming 是私有目录。
		await write.writeFile("notes.md", "x");
		await write.writeFile("scripts/count.py", "print(1)\n");
		for (const path of [".suiming/project.json", ".git/config", ".SUIMING/project.json"]) {
			await assert.rejects(write.writeFile(path, "x"), { code: "permission_denied" });
			await assert.rejects(write.readTextFile(path), { code: "permission_denied" });
		}
		const design = new ConfinedExecutionEnv({
			rootPath: root,
			policy: "write",
			writable: (path) => path.startsWith("intent/"),
		});
		await design.writeFile("intent/c.md", "c\n");
		await assert.rejects(design.writeFile("text/beat-0001.md", "正文"), { code: "permission_denied" });
		const read = new ConfinedExecutionEnv({ rootPath: root, policy: "read" });
		assert.equal(await read.readTextFile("intent/a.md"), "intent\n");
		await assert.rejects(read.writeFile("intent/a.md", "changed"), { code: "permission_denied" });
		// 删除走的是同一条 journal 路径；只读环境连准备删除都不允许。
		await assert.rejects(read.prepareWrite("intent/a.md", null), { code: "permission_denied" });
		assert.equal("exec" in read, false);
		assert.equal("createTempDir" in read, false);
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("文件 journal 恢复识别未应用、已应用和外部冲突，重复 edit 不会再替换一次", async () => {
	const { root } = await sandbox();
	try {
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		const mutation = await env.prepareWrite("intent/a.md", "new");
		await env.applyMutation(mutation);
		await env.applyMutation(mutation);
		assert.equal(await env.readTextFile("intent/a.md"), "new");
		await writeFile(join(root, "intent/a.md"), "author edit");
		await assert.rejects(env.applyMutation(mutation), { code: "file_write_conflict" });
		assert.equal(await env.readTextFile("intent/a.md"), "author edit");
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("list：列出一层目录，目录带斜杠；.git / .suiming 与 symlink 不出现，越界与非目录被拒，读范围照样生效", async () => {
	const { root, outside } = await sandbox();
	try {
		await mkdir(join(root, ".git"), { recursive: true });
		await mkdir(join(root, ".suiming"), { recursive: true });
		await mkdir(join(root, "review"), { recursive: true });
		await writeFile(join(root, "review", "r1.md"), "审稿\n");
		await symlink(outside, join(root, "linked"));
		const { fileTools } = await import("../src/harness/tools.js");
		const listOf = async (env: ConfinedExecutionEnv, path?: string) => {
			const tool = fileTools(env, "read").find((item) => item.name === "list");
			assert.ok(tool, "只读角色也有 list");
			const prepared = await tool.prepare?.(path === undefined ? {} : { path });
			return (prepared as { content: { text: string }[] }).content[0]?.text ?? "";
		};
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "read" });
		assert.equal(await listOf(env), "evidence/\nintent/\nreview/");
		// 模型列根目录时会传 path: ""；loop 先按 schema 校验参数，校验不过就是一次白费的工具调用。
		const listTool = fileTools(env, "read").find((item) => item.name === "list");
		assert.ok(listTool && Value.Check(listTool.parameters, { path: "" }), 'schema 收 path: ""');
		assert.equal(await listOf(env, ""), "evidence/\nintent/\nreview/", "空字符串也是根目录");
		assert.equal(await listOf(env, "review"), "review/r1.md");
		await assert.rejects(listOf(env, "../outside"), { code: "permission_denied" });
		await assert.rejects(listOf(env, ".git"), { code: "permission_denied" });
		await assert.rejects(listOf(env, "review/r1.md"), { code: "not_a_directory" });
		await assert.rejects(listOf(env, "missing"), { code: "file_not_found" });
		const narrow = new ConfinedExecutionEnv({
			rootPath: root,
			policy: "read",
			readable: (path) => !path.startsWith("review/"),
		});
		assert.equal(await listOf(narrow, "review"), "（空目录）", "读不到的文件不列出名字");
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("host 接入目录：模型的环境列不出、读不到、写不了（大小写不同也一样），入口文件照常可读；作者的视图照常可见", async () => {
	const { root } = await sandbox();
	try {
		// suim init / update --agent 写的形状（apps/cli/src/host-install.ts）
		for (const path of [
			".agents/skills/suiming/SKILL.md",
			".claude/skills/suiming/SKILL.md",
			".grok/skills/suiming/SKILL.md",
			".codex/agents/suim_storytext_writer.toml",
		]) {
			await mkdir(join(root, path, ".."), { recursive: true });
			await writeFile(join(root, path), "用 `suim --json check` 检查\n");
		}
		await writeFile(join(root, "AGENTS.md"), "# 我的约束\n");
		const { fileTools } = await import("../src/harness/tools.js");
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		const list = fileTools(env, "write").find((item) => item.name === "list");
		assert.ok(list);
		const listed = await list.prepare?.({});
		assert.equal((listed as { content: { text: string }[] }).content[0]?.text, "AGENTS.md\nevidence/\nintent/");
		for (const path of [".agents/skills/suiming/SKILL.md", ".Claude/skills/suiming/SKILL.md", ".codex/agents"]) {
			await assert.rejects(env.readTextFile(path), { code: "permission_denied", message: /接入文件/u });
		}
		await assert.rejects(env.listEntries(".grok"), { code: "permission_denied" });
		await assert.rejects(env.writeFile(".claude/settings.json", "{}"), { code: "permission_denied" });
		await assert.rejects(env.prepareWrite(".agents/skills/suiming/SKILL.md", null), { code: "permission_denied" });
		assert.equal(await env.readTextFile("AGENTS.md"), "# 我的约束\n");

		const author = new ConfinedExecutionEnv({ rootPath: root, policy: "read", hostAdapters: "visible" });
		assert.match(await author.readTextFile(".agents/skills/suiming/SKILL.md"), /suim/u);
		assert.deepEqual(
			(await author.listEntries(".")).filter((entry) => entry.startsWith(".")),
			[".agents/", ".claude/", ".codex/", ".grok/"],
		);
		await assert.rejects(author.readTextFile(".git/config"), { code: "permission_denied" });
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("write / edit 的结果带写入后的字数：模型汇报篇幅以它为准，不靠估算", async () => {
	// 2026-10-01 斗破真实运行：Writer 写完 beat-0001 报「四章约一万字」，文件实际 6,745 码点——它手上没有确定的数。
	const { root } = await sandbox();
	try {
		const { fileTools } = await import("../src/harness/tools.js");
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		const tools = fileTools(env, "write");
		const run = async (name: string, params: Record<string, unknown>) => {
			const tool = tools.find((item) => item.name === name);
			assert.ok(tool);
			const prepared = await tool.prepare?.(params);
			const result = await tool.execute("call", params, undefined, undefined, prepared);
			return (result as { content: { text: string }[] }).content[0]?.text ?? "";
		};
		assert.match(
			await run("write", { path: "text/beat-0001.md", content: "第一章\n\n他推门。" }),
			/，9 字；段落 2，平均段长 4 字$/u,
		);
		await run("read", { path: "text/beat-0001.md" });
		assert.match(
			await run("edit", { path: "text/beat-0001.md", oldText: "他推门。", newText: "他推开门。" }),
			/，10 字；段落 2，平均段长 4 字$/u,
		);
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("读、写、删一个目录：如实拒绝并指向 list，不抛原始 EISDIR 掀掉整个 turn", async () => {
	// 2026-10-01 真实模型回归里委派的 Writer 读了一个目录，原始 EISDIR 被 loop 当基础设施故障，整个 turn 失败。
	const { root } = await sandbox();
	try {
		const directoryRejected = (error: { name?: string; code?: string; message?: string }) => {
			assert.equal(error.name, "ToolRejection");
			assert.equal(error.code, "is_a_directory");
			assert.match(error.message ?? "", /list/u);
			return true;
		};
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		await assert.rejects(env.readTextFile("intent"), directoryRejected);
		// 写或删一个目录的路径同理：准备 journal 时要读原内容。
		await assert.rejects(env.prepareWrite("intent", "x"), directoryRejected);
		await assert.rejects(env.prepareWrite("intent", null), directoryRejected);
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("copy：整个目录或单个文件原样复制，Source 提升为 Target 不经模型重打；复制进自身、越界、只读都被拒绝", async () => {
	// 2026-10-02 斗破抽取：Agent 没有复制工具，「原样提升」只能把一百多个文件逐个 read 出来、让模型整篇重打一遍再 write，
	// 半个多小时，还可能抄走样。host 的 Claude Code 一条 cp 就完了。
	const { root } = await sandbox();
	try {
		const { fileTools } = await import("../src/harness/tools.js");
		const files: Record<string, string> = {
			"source/访谈/world/core.md": "世界\n",
			"source/访谈/world/characters/李牧.md": "---\nname: 李牧\n---\n核对证据的人。\n",
			"source/访谈/outline/story/vol-0001/beat-0001.md": "---\ntitle: 密信\n---\n找到密信。\n",
		};
		for (const [path, content] of Object.entries(files)) {
			await mkdir(join(root, path, ".."), { recursive: true });
			await writeFile(join(root, path), content);
		}
		await mkdir(join(root, "world"), { recursive: true });
		await writeFile(join(root, "world/core.md"), "旧的世界\n");
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		const tools = fileTools(env, "write");
		const copy = tools.find((item) => item.name === "copy");
		assert.ok(copy);
		const run = async (params: Record<string, unknown>) => {
			const prepared = await copy.prepare?.(params);
			const first = await copy.execute("call", params, undefined, undefined, prepared);
			// 恢复时按 journal 重放：已经落盘的不算冲突，结果不变
			const again = await copy.execute("call", params, undefined, undefined, prepared);
			assert.deepEqual(again, first);
			return (first as { content: { text: string }[] }).content[0]?.text ?? "";
		};

		assert.match(await run({ from: "source/访谈/world", to: "world" }), /2 个文件.*新建 1.*覆盖 1/u);
		assert.equal(await readFile(join(root, "world/core.md"), "utf8"), files["source/访谈/world/core.md"]);
		assert.equal(
			await readFile(join(root, "world/characters/李牧.md"), "utf8"),
			files["source/访谈/world/characters/李牧.md"],
		);
		await run({ from: "source/访谈/outline/story/vol-0001/beat-0001.md", to: "outline/story/vol-0001/beat-0001.md" });
		assert.equal(
			await readFile(join(root, "outline/story/vol-0001/beat-0001.md"), "utf8"),
			files["source/访谈/outline/story/vol-0001/beat-0001.md"],
		);

		const rejected = (code: string) => (error: { name?: string; code?: string }) =>
			error.name === "ToolRejection" && error.code === code;
		await assert.rejects(
			Promise.resolve(copy.prepare?.({ from: "source", to: "source/访谈/备份" })),
			rejected("copy_into_itself"),
		);
		await assert.rejects(Promise.resolve(copy.prepare?.({ from: "不存在", to: "x" })), rejected("file_not_found"));
		await assert.rejects(Promise.resolve(copy.prepare?.({ from: "world", to: "../outside/world" })), {
			name: "ToolRejection",
		});
		assert.equal(
			fileTools(new ConfinedExecutionEnv({ rootPath: root, policy: "read" }), "read").some(
				(item) => item.name === "copy",
			),
			false,
		);
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});

test("move：一条调用把几个 Beat 挪进另一卷，或给文件 / 目录改名；目标已有不同内容、挪进自身、只读都被拒绝", async () => {
	// 2026-10-03 斗破 120 章：整合给 153 节分卷，没有 move，只能逐个 copy 再 delete，三百来次工具调用。
	// 换卷是改 index.yaml 加 mv 文件两步，host 一条 mv 就完了。
	const { root } = await sandbox();
	try {
		const { fileTools } = await import("../src/harness/tools.js");
		const beat = (id: string) => `outline/story/vol-0001/${id}.md`;
		for (const id of ["beat-0101", "beat-0102", "beat-0103"]) {
			await mkdir(join(root, "outline/story/vol-0001"), { recursive: true });
			await writeFile(join(root, beat(id)), `---\ntitle: ${id}\n---\n${id}。\n`);
		}
		await mkdir(join(root, "world"), { recursive: true });
		await writeFile(join(root, "world/旧名.md"), "设定\n");
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		const move = fileTools(env, "write").find((item) => item.name === "move");
		assert.ok(move);
		const run = async (params: Record<string, unknown>) => {
			const prepared = await move.prepare?.(params);
			const first = await move.execute("call", params, undefined, undefined, prepared);
			// 恢复时按 journal 重放：已经挪过去的不算冲突，结果不变
			const again = await move.execute("call", params, undefined, undefined, prepared);
			assert.deepEqual(again, first);
			return (first as { content: { text: string }[] }).content[0]?.text ?? "";
		};
		const exists = (path: string) =>
			readFile(join(root, path), "utf8").then(
				() => true,
				() => false,
			);

		assert.match(
			await run({ from: [beat("beat-0102"), beat("beat-0103")], to: "outline/story/vol-0002" }),
			/2 个文件/u,
		);
		assert.equal(
			await readFile(join(root, "outline/story/vol-0002/beat-0102.md"), "utf8"),
			"---\ntitle: beat-0102\n---\nbeat-0102。\n",
		);
		assert.equal(await exists(beat("beat-0102")), false, "原处不留");
		assert.equal(await exists(beat("beat-0101")), true, "没点名的不动");
		await run({ from: ["world/旧名.md"], to: "world/新名.md" });
		assert.equal(await readFile(join(root, "world/新名.md"), "utf8"), "设定\n");
		await run({ from: ["outline/story/vol-0002"], to: "outline/story/vol-0003" });
		assert.equal(await exists("outline/story/vol-0003/beat-0103.md"), true, "整个目录改名");

		const rejected = (code: string) => (error: { name?: string; code?: string }) =>
			error.name === "ToolRejection" && error.code === code;
		await writeFile(join(root, "world/另一份.md"), "别的设定\n");
		await assert.rejects(
			Promise.resolve(move.prepare?.({ from: ["world/新名.md"], to: "world/另一份.md" })),
			rejected("move_target_exists"),
		);
		await assert.rejects(
			Promise.resolve(move.prepare?.({ from: ["outline/story"], to: "outline/story/vol-0009" })),
			rejected("move_into_itself"),
		);
		await assert.rejects(
			Promise.resolve(move.prepare?.({ from: ["不存在.md"], to: "x.md" })),
			rejected("file_not_found"),
		);
		assert.equal(
			fileTools(new ConfinedExecutionEnv({ rootPath: root, policy: "read" }), "read").some(
				(item) => item.name === "move",
			),
			false,
		);
	} finally {
		await rm(join(root, ".."), { recursive: true, force: true });
	}
});
