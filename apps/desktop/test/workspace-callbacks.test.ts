import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

type CallbackFixture = typeof globalThis & {
	workspaceTestCallbacks: { command: string; before?: boolean; release?: () => void };
};

test("关闭发起窗格后，附件与委托回包仍更新共享草稿", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-workspace-callback-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--workspace-callback-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors = collectPageErrors(page);
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

test("迟到保存回执：保留提交后的继续输入，切页后不抢焦点或覆盖另一文件草稿", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-save-callback-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	await writeFile(join(root, "甲.md"), "甲的原文");
	await writeFile(join(root, "乙.md"), "乙的原文");
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--workspace-callback-test"] });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(8000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		const tabIds: string[] = [];
		for (const name of ["甲", "乙"]) {
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(`${name}.md`);
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await editor.fill(`${name}的草稿`);
			tabIds.push((await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id")) ?? "");
		}
		const activate = (index: number) => page.locator(`[data-tab-id="${tabIds[index]}"]`).click();
		await activate(0);
		await app.evaluate(() => {
			(globalThis as CallbackFixture).workspaceTestCallbacks.command = "workspace.file.save";
		});
		await page.keyboard.press("Meta+s");
		await eventually(
			() => app.evaluate(() => !!(globalThis as CallbackFixture).workspaceTestCallbacks.release),
			"保存已经完成，回执待释放",
		);
		await editor.fill("甲的草稿，保存后继续写");
		await activate(1);
		await editor.focus();
		await app.evaluate(() => (globalThis as CallbackFixture).workspaceTestCallbacks.release?.());
		await eventually(() => page.getByRole("button", { name: "保存 ⌘S", exact: true }).isEnabled(), "保存回执已处理");
		await eventually(
			() => editor.evaluate((element) => element === element.ownerDocument.activeElement),
			"回执不抢另一文档焦点",
		);
		assert.equal(await editor.innerText(), "乙的草稿");
		assert.equal(await readFile(join(root, "甲.md"), "utf8"), "甲的草稿");
		await activate(0);
		assert.equal(await editor.innerText(), "甲的草稿，保存后继续写");
		await page.reload();
		await editor.waitFor();
		assert.equal(await editor.innerText(), "甲的草稿，保存后继续写");
		await activate(1);
		assert.equal(await editor.innerText(), "乙的草稿");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("迟到保存失败：发送后磁盘被改，切页后不抢焦点；原文件草稿保留并显示冲突", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-save-failure-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	for (const name of ["甲", "乙"]) await writeFile(join(root, `${name}.md`), `${name}的原文`);
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--workspace-callback-test"] });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(8000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		const tabs: string[] = [];
		for (const name of ["甲", "乙"]) {
			await page.keyboard.press("Meta+t");
			await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(`${name}.md`);
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
			await editor.fill(`${name}的草稿`);
			tabs.push((await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id")) ?? "");
		}
		const activate = (index: number) => page.locator(`[data-tab-id="${tabs[index]}"]`).click();
		await activate(0);
		await app.evaluate(() => {
			Object.assign((globalThis as CallbackFixture).workspaceTestCallbacks, {
				command: "workspace.file.save",
				before: true,
			});
		});
		await page.keyboard.press("Meta+s");
		await eventually(
			() => app.evaluate(() => !!(globalThis as CallbackFixture).workspaceTestCallbacks.release),
			"保存命令已发出，尚未执行",
		);
		await writeFile(join(root, "甲.md"), "Agent 已修改磁盘内容");
		await editor.fill("甲的草稿，发送后继续输入");
		await activate(1);
		await editor.focus();
		await app.evaluate(() => (globalThis as CallbackFixture).workspaceTestCallbacks.release?.());
		await eventually(
			() => page.getByRole("button", { name: "保存 ⌘S", exact: true }).isEnabled(),
			"CAS 拒绝回执已处理",
		);
		assert.ok(await editor.evaluate((element) => element === element.ownerDocument.activeElement));
		assert.equal(await editor.innerText(), "乙的草稿");
		assert.equal(await readFile(join(root, "甲.md"), "utf8"), "Agent 已修改磁盘内容");
		assert.equal(await page.getByRole("button", { name: "外部修改冲突", exact: true }).count(), 0, "错误不串到乙");
		await activate(0);
		await page.getByRole("button", { name: "外部修改冲突", exact: true }).waitFor();
		assert.equal(await editor.innerText(), "甲的草稿，发送后继续输入");
		await page.reload();
		await page.getByRole("button", { name: "外部修改冲突", exact: true }).waitFor();
		assert.equal(await editor.innerText(), "甲的草稿，发送后继续输入");
		await activate(1);
		assert.equal(await editor.innerText(), "乙的草稿");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
