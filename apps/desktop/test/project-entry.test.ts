import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import type { ElectronApplication } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge };

async function selectDirectory(app: ElectronApplication, path?: string) {
	await app.evaluate(({ dialog }, selected) => {
		dialog.showOpenDialog = (async () => ({
			canceled: selected === null,
			filePaths: selected ? [selected] : [],
		})) as typeof dialog.showOpenDialog;
	}, path ?? null);
}

async function work(path: string) {
	await mkdir(path);
	await materializeOpenStoryDirectorySnapshot(path, [
		...sampleWorkFiles(),
		{
			path: "text/beat-0001.md",
			mediaType: "text/markdown",
			bytes: new TextEncoder().encode("安装后的原文。\n"),
		},
	]);
	(await LocalProjectService.init({ checkoutPath: path })).close();
}

test("新建与取消：误选非空目录不初始化、不切作品，编辑和对话草稿在失败与重载后保留", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-project-entry-"));
	const root = join(directory, "原作品");
	await work(root);
	const app = await launchDesktop({ directory, project: root });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(5000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		await editor.fill("未保存正文，不能因选择错误而丢失。\n");
		await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("尚未发送的作者要求");
		const original = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		const stored = await readFile(join(directory, "app-data/workspace.json"), "utf8");
		await selectDirectory(app);
		await page.getByRole("button", { name: "切换作品", exact: true }).click();
		await page.getByRole("button", { name: "打开作品…", exact: true }).click();
		assert.equal(
			(await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId,
			original.projectId,
		);
		await page.keyboard.press("Escape");

		const foreign = join(directory, "其他资料");
		await mkdir(foreign);
		await writeFile(join(foreign, "notes.txt"), "不能加入任何作品文件\n");
		await selectDirectory(app, foreign);
		await page.getByRole("button", { name: "切换作品", exact: true }).click();
		await page.getByRole("button", { name: "新建作品", exact: true }).click();
		await page.getByText(/新建作品请选择空文件夹/).waitFor();
		await mkdir("/tmp/suiming-project-entry-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-project-entry-qa/nonempty.png" });
		await page.keyboard.press("Escape");
		assert.deepEqual(await readdir(foreign), ["notes.txt"]);
		assert.equal(await readFile(join(foreign, "notes.txt"), "utf8"), "不能加入任何作品文件\n");
		assert.equal(await readFile(join(directory, "app-data/workspace.json"), "utf8"), stored);
		assert.equal(
			(await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId,
			original.projectId,
		);
		// 只有隐藏内容也不是新作品的空目录；已有作品也不能被「新建」悄悄当作打开。
		for (const path of [join(directory, "隐藏资料"), root]) {
			if (path !== root) {
				await mkdir(path);
				await writeFile(join(path, ".keep"), "保留");
			}
			await selectDirectory(app, path);
			await assert.rejects(
				page.evaluate(() => window.suiming.chooseProject(true)),
				/新建作品请选择空文件夹/,
			);
		}
		const unreadable = join(directory, "无权限目录");
		await mkdir(unreadable);
		await chmod(unreadable, 0);
		try {
			await selectDirectory(app, unreadable);
			await assert.rejects(
				page.evaluate(() => window.suiming.chooseProject(false)),
				/无法读取作品文件夹.*无权限目录/s,
			);
		} finally {
			await chmod(unreadable, 0o700);
		}
		const notDirectory = join(foreign, "notes.txt");
		await selectDirectory(app, notDirectory);
		await assert.rejects(
			page.evaluate(() => window.suiming.chooseProject(false)),
			/作品路径不是文件夹/,
		);
		assert.equal(await readFile(join(directory, "app-data/workspace.json"), "utf8"), stored);
		await page.reload();
		await editor.waitFor();
		assert.match(await editor.innerText(), /未保存正文/);
		assert.equal(
			await page.getByRole("textbox", { name: "输入消息", exact: true }).inputValue(),
			"尚未发送的作者要求",
		);
		assert.equal(await readFile(join(root, "text/beat-0001.md"), "utf8"), "安装后的原文。\n");
		const fresh = join(directory, "新作品");
		await mkdir(fresh);
		await writeFile(join(fresh, ".DS_Store"), "Finder metadata");
		await selectDirectory(app, fresh);
		await page.getByRole("button", { name: "切换作品", exact: true }).click();
		await page.getByRole("button", { name: "新建作品", exact: true }).click();
		await eventually(
			async () =>
				(await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId !== original.projectId,
			"新作品已打开",
		);
		const created = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		assert.equal(created.checkoutPath, await realpath(fresh));
		assert.equal(created.revisions.length, 1);
		assert.notEqual(created.projectId, original.projectId);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("作品移动后启动：说明失效路径，取消不改记录，重新选择目录保留 Canon 与候选", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-project-moved-"));
	const oldPath = join(directory, "原位置");
	const moved = join(directory, "新位置");
	await work(oldPath);
	await writeFile(join(oldPath, "intent/候选.md"), "保留移动前的候选。\n");
	const before = await LocalProjectService.open(oldPath);
	const history = await before.history();
	const id = before.projectId;
	before.close();
	await rename(oldPath, moved);
	await mkdir(join(directory, "app-data"));
	const storedPath = join(directory, "app-data/workspace.json");
	const stored = JSON.stringify({ path: oldPath, recent: [oldPath] });
	await writeFile(storedPath, stored);
	const app = await launchDesktop({ directory });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(5000);
		const errors = collectPageErrors(page);
		await page.getByRole("alert").filter({ hasText: "找不到作品文件夹" }).waitFor();
		assert.match(await page.getByRole("alert").innerText(), /原位置/);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await mkdir("/tmp/suiming-project-entry-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-project-entry-qa/moved.png" });
		await selectDirectory(app);
		await page.getByRole("button", { name: "打开作品 ↗" }).click();
		assert.equal(await readFile(storedPath, "utf8"), stored);
		await selectDirectory(app, moved);
		await page.getByRole("button", { name: "打开作品 ↗" }).click();
		await page.getByRole("textbox", { name: "输入消息", exact: true }).waitFor();
		const shown = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		assert.equal(shown.projectId, id);
		assert.equal(shown.dirty, true);
		assert.deepEqual(
			shown.revisions.map((revision) => revision.id),
			history.map((revision) => revision.id),
		);
		assert.equal(await readFile(join(moved, "intent/候选.md"), "utf8"), "保留移动前的候选。\n");
		await page.reload();
		await page.getByRole("textbox", { name: "输入消息", exact: true }).waitFor();
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId, id);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
