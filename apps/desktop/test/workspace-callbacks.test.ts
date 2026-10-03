import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { _electron as electron } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

type CallbackFixture = typeof globalThis & { workspaceTestCallbacks: { command: string; release?: () => void } };

test("关闭发起窗格后，附件与委托回包仍更新共享草稿", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-workspace-callback-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			"--workspace-callback-test",
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const active = () => page.locator('[data-pane-active="true"]');
	const menu = async (name: string) => {
		await active().getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name, exact: true }).click();
	};
	const hold = (command: string) =>
		app.evaluate((_, value) => {
			(globalThis as CallbackFixture).workspaceTestCallbacks.command = value;
		}, command);
	const release = async () => {
		await assert.doesNotReject(async () => {
			for (let i = 0; i < 40; i++) {
				if (await app.evaluate(() => !!(globalThis as CallbackFixture).workspaceTestCallbacks.release)) {
					await app.evaluate(() => (globalThis as CallbackFixture).workspaceTestCallbacks.release?.());
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error("未收到待释放回包");
		});
	};
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1800, 940));
		await menu("左右分屏");
		await page.locator("[data-pane-id]").nth(1).waitFor();
		await hold("workspace.file.read");
		await page.getByRole("button", { name: "添加内容", exact: true }).click();
		await page.getByRole("menuitem", { name: "引用当前文档", exact: true }).click();
		await page.locator(".composer-attachments .animate-spin").waitFor();
		await menu("合并到相邻窗格");
		await release();
		await page.getByRole("button", { name: "查看引用内容", exact: true }).click();
		await page.getByText(/文件内容 SHA-256/).waitFor();
		await page.keyboard.press("Escape");
		await menu("左右分屏");
		await hold("session.send");
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		await input.fill("检查这份设计");
		await input.press("Meta+Enter");
		await page.getByText("正在确认本次发送，可以继续输入。", { exact: true }).waitFor();
		await input.fill("回包前新增的草稿");
		await menu("合并到相邻窗格");
		await release();
		await page.getByText("正在确认本次发送，可以继续输入。", { exact: true }).waitFor({ state: "hidden" });
		assert.equal(await input.inputValue(), "回包前新增的草稿");
		await page.reload();
		await input.waitFor();
		assert.equal(await input.inputValue(), "回包前新增的草稿");
		assert.equal(await page.locator("[data-pane-id]").count(), 1);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
