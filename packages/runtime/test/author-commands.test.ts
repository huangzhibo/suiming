import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAuthorCommands } from "../src/local/author-commands.js";

// ADR-0038 决定三：作者存的常用话放在 config.toml 同目录的 commands/ 下；一个坏文件不能挡住整个菜单。
test("从配置目录的 commands/ 读作者的常用话：文件名是命令名，坏文件与过大的文件跳过，没有目录是空表", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-author-commands-"));
	try {
		const config = join(root, "config.toml");
		assert.deepEqual(await readAuthorCommands(config), []);
		await mkdir(join(root, "commands"));
		await writeFile(join(root, "commands", "写下一节.md"), "按大纲写下一节正文：$ARGUMENTS\n");
		await writeFile(join(root, "commands", "审稿.md"), "独立审一下 $ARGUMENTS");
		await writeFile(join(root, "commands", "空的.md"), "   \n");
		await writeFile(join(root, "commands", "带 空格.md"), "名字里有空格的不收");
		await writeFile(join(root, "commands", "大.md"), "字".repeat(20_000));
		await writeFile(join(root, "commands", "说明.txt"), "不是 .md 的不收");
		await mkdir(join(root, "commands", "目录.md"));
		assert.deepEqual(await readAuthorCommands(config), [
			{ name: "写下一节", text: "按大纲写下一节正文：$ARGUMENTS" },
			{ name: "审稿", text: "独立审一下 $ARGUMENTS" },
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
