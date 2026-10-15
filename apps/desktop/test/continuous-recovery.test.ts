import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, openGate, waitForSessionIdle } from "./launch.js";

declare const window: { suiming: DesktopBridge };
type Pending = typeof globalThis & { workspaceTestCallbacks: { command: string; release?: () => void } };

test("跨作品组合：未保存正文遇到外部修改，切换、重载与迟到附件不串作品，合并提交保留两方内容", {
	timeout: 60000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-continuous-recovery-"));
	const path = "text/beat-0001.md";
	const roots = [join(directory, "甲作品"), join(directory, "乙作品")] as const;
	for (const [index, root] of roots.entries()) {
		await mkdir(root);
		await materializeOpenStoryDirectorySnapshot(root, [
			...sampleWorkFiles(),
			{
				path,
				mediaType: "text/markdown",
				bytes: new TextEncoder().encode(`作品${index}原文。\n`),
			},
		]);
		(await LocalProjectService.init({ checkoutPath: root, projectId: `combined-${index}` })).close();
	}
	const app = await launchDesktop({
		directory,
		project: roots[0],
		flags: ["--workspace-callback-test", "--hold-first-reply"],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const switchTo = async (root: string) => {
		await app.evaluate(({ dialog }, selected) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [selected],
			})) as typeof dialog.showOpenDialog;
		}, root);
		await page.evaluate(() => window.suiming.chooseProject(false));
		await eventually(
			async () =>
				(await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).checkoutPath.endsWith(
					basename(root),
				),
			"作品切换完成",
		);
		await page.getByText(basename(root), { exact: true }).waitFor();
	};
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await editor.fill("作品0原文。\n作者未保存补写。\n");
		await page.locator('.tab-btn[data-active="true"] [aria-label="未保存"]').waitFor();
		await page.getByRole("radio", { name: "设计", exact: true }).click();
		await app.evaluate(() => {
			(globalThis as Pending).workspaceTestCallbacks.command = "workspace.file.read";
		});
		await page.getByRole("button", { name: "添加内容", exact: true }).click();
		await page.getByRole("menuitem", { name: "引用当前文档", exact: true }).click();
		await eventually(
			() => app.evaluate(() => !!(globalThis as Pending).workspaceTestCallbacks.release),
			"附件回包被闸门截住",
		);
		await switchTo(roots[1]);
		await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("乙作品独立草稿");
		await app.evaluate(() => (globalThis as Pending).workspaceTestCallbacks.release?.());
		await writeFile(join(roots[0], path), "作品0原文。\n外部补写。\n");
		await page.reload();
		await page.getByRole("textbox", { name: "输入消息", exact: true }).waitFor();
		assert.equal(await page.getByRole("textbox", { name: "输入消息", exact: true }).inputValue(), "乙作品独立草稿");
		assert.equal(await page.getByRole("button", { name: "查看引用内容", exact: true }).count(), 0);
		await switchTo(roots[0]);
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await editor.waitFor();
		assert.match(await editor.innerText(), /作者未保存补写/u);
		await page.getByRole("button", { name: "外部修改冲突", exact: true }).waitFor();
		await page.reload();
		await page.getByRole("button", { name: "外部修改冲突", exact: true }).waitFor();
		assert.match(await editor.innerText(), /作者未保存补写/u);
		assert.equal(await readFile(join(roots[0], path), "utf8"), "作品0原文。\n外部补写。\n");
		await page.getByRole("button", { name: "外部修改冲突", exact: true }).click();
		await page.getByRole("button", { name: "比较外部修改", exact: true }).click();
		await page.locator(".cm-merge-a .cm-content").filter({ hasText: "外部补写" }).waitFor();
		await page.locator(".cm-merge-b .cm-content").filter({ hasText: "作者未保存补写" }).waitFor();
		await page.locator(".cm-merge-b .cm-content").fill("作品0原文。\n外部补写。\n作者未保存补写。\n");
		await page.getByRole("button", { name: "外部修改冲突", exact: true }).click();
		await page.getByRole("button", { name: "以外部版本为合并基线", exact: true }).click();
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByText("已保存", { exact: true }).waitFor();
		await page.getByRole("button", { name: "提交版本", exact: true }).click();
		await page.getByText("已提交一个新版本", { exact: true }).waitFor();
		assert.equal(await readFile(join(roots[0], path), "utf8"), "作品0原文。\n外部补写。\n作者未保存补写。\n");
		assert.equal(await readFile(join(roots[1], path), "utf8"), "作品1原文。\n");
		const a = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		assert.equal(a.revisions.length, 2);
		assert.equal(a.dirty, false);
		const sent = await page.evaluate(() =>
			window.suiming.invoke("session.send", {
				commandId: "combined-running-switch",
				text: "只讨论，不修改作品",
			}),
		);
		await assert.rejects(switchTo(roots[1]), /请先停止再切换作品/u);
		await openGate(app, "first-reply");
		await waitForSessionIdle(page, sent.sessionId);
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisions.length, 2);
		await switchTo(roots[1]);
		const b = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		assert.equal(b.revisions.length, 1);
		assert.equal(b.dirty, false);
		assert.equal((await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions.length, 0);
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-continuous-recovery-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("独立审稿服务失败，重载后从原任务续做，已完成的读取与提交不重复", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-reviewer-recovery-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--reviewer-recovery-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	try {
		await input.fill("独立审稿");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "独立审稿模型暂时失败" }).waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const sessionId = (await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.id;
		assert.ok(sessionId);
		const tasks = await page.evaluate((id) => window.suiming.invoke("session.tasks", { sessionId: id }), sessionId);
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0]?.status, "failed");
		await page.reload();
		await page.locator(".message.assistant").filter({ hasText: "独立审稿模型暂时失败" }).waitFor();
		await input.fill("继续");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "已沿用原审稿进度完成并提交" }).waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const resumed = await page.evaluate((id) => window.suiming.invoke("session.tasks", { sessionId: id }), sessionId);
		assert.equal(resumed.length, 1);
		assert.equal(resumed[0]?.id, tasks[0]?.id);
		assert.equal(resumed[0]?.status, "completed");
		const shown = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		assert.equal(shown.revisions.length, 2);
		assert.equal(shown.dirty, false);
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.reviews", {}))).length, 1);
		await page.reload();
		await page.locator(".message.assistant").filter({ hasText: "已沿用原审稿进度完成并提交" }).waitFor();
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisions.length, 2);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
