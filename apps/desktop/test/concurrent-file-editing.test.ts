import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, openGate } from "./launch.js";

type Callbacks = typeof globalThis & {
	workspaceTestCallbacks: { command: string; release?: () => void };
	testGateReached(name: string): boolean;
};

test("持续 Agent 写入与多文件草稿：手动保存迟到回执与自动合并共存，其他草稿和焦点保留", {
	timeout: 60000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-concurrent-edit-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	for (const name of ["甲", "乙"]) await writeFile(join(root, `${name}.md`), `${name}的原文`);
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({
		directory,
		project: root,
		flags: ["--workspace-callback-test", "--concurrent-file-test"],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const button = (name: string) => page.getByRole("button", { name, exact: true });
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	const waitGate = (name: string) =>
		eventually(() => app.evaluate((_, name) => (globalThis as Callbacks).testGateReached(name), name), name);
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const tabs: string[] = [];
		for (const name of ["甲", "乙"]) {
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(`${name}.md`);
			await page.keyboard.press("Enter");
			await button("切换到编辑视图").click();
			await editor.fill(`${name}的草稿`);
			tabs.push((await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id")) ?? "");
		}
		const activate = (index: number) => page.locator(`[data-tab-id="${tabs[index]}"]`).click();
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		await input.fill("继续修改甲文件，保留作者保存的内容");
		await input.press("Meta+Enter");
		await waitGate("agent-stale-write");
		await activate(0);
		await editor.fill("甲的草稿，手动保存");
		await app.evaluate(() => {
			(globalThis as Callbacks).workspaceTestCallbacks.command = "workspace.file.save";
		});
		await page.keyboard.press("Meta+s");
		await eventually(
			() => app.evaluate(() => !!(globalThis as Callbacks).workspaceTestCallbacks.release),
			"作者保存落盘，回执暂扣",
		);
		assert.equal(await readFile(join(root, "甲.md"), "utf8"), "甲的草稿，手动保存");
		await editor.fill("甲的草稿，手动保存，作者继续写");
		await activate(1);
		await editor.focus();
		await openGate(app, "agent-stale-write");
		await waitGate("agent-finish");
		assert.equal(await readFile(join(root, "甲.md"), "utf8"), "甲的草稿，手动保存，作者继续写，Agent 合并");
		await app.evaluate(() => (globalThis as Callbacks).workspaceTestCallbacks.release?.());
		assert.equal(await editor.innerText(), "乙的草稿");
		assert.ok(await editor.evaluate((element) => element === element.ownerDocument.activeElement));
		await activate(0);
		await eventually(
			async () => (await editor.innerText()) === "甲的草稿，手动保存，作者继续写，Agent 合并",
			"旧手动保存回执没有恢复旧稿",
		);
		await openGate(app, "agent-finish");
		await page.locator(".message.assistant").filter({ hasText: "已保留作者保存的内容" }).waitFor();
		await activate(1);
		await editor.focus();
		await page.reload();
		await editor.waitFor();
		assert.equal(await editor.innerText(), "乙的草稿");
		assert.equal(await readFile(join(root, "乙.md"), "utf8"), "乙的原文");
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-concurrent-edit-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
