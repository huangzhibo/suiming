import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import type { ElectronApplication, Locator, Page } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import type { WorkspaceLayout } from "../../workbench/src/workspace-layout.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge; localStorage: { getItem(key: string): string | null } };
const targets = ["text/beat-0001.md", "world/characters/黄盖.md", "notes.md"] as const;
const focused = (locator: Locator) => locator.evaluate((element) => element === element.ownerDocument.activeElement);
const editorText = (editor: Locator) =>
	editor.locator(".cm-line").evaluateAll((lines) => lines.map((line) => line.textContent).join("\n"));

async function fixture() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "suiming-multi-draft-")));
	const roots = [join(directory, "甲作品"), join(directory, "乙作品")] as const;
	const originals: [Record<string, string>, Record<string, string>] = [{}, {}];
	for (const index of [0, 1] as const) {
		const root = roots[index];
		await mkdir(root);
		await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
		await mkdir(join(root, "text"), { recursive: true });
		await writeFile(join(root, targets[0]), `作品${index}的原正文。\n`);
		await writeFile(join(root, targets[2]), `# 作品${index}的笔记\n保留原笔记。\n`);
		(await LocalProjectService.init({ checkoutPath: root })).close();
		originals[index] = Object.fromEntries(
			await Promise.all(targets.map(async (path) => [path, await readFile(join(root, path), "utf8")])),
		);
	}
	return { directory, roots, originals };
}

async function openFile(page: Page, path: string) {
	await page.keyboard.press("Meta+t");
	await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(path);
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	await eventually(() => focused(editor), "打开文件进入编辑器");
	return editor;
}

async function switchProject(app: ElectronApplication, page: Page, root: string, recent = false) {
	if (!recent)
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
		}, root);
	await page.getByRole("button", { name: "切换作品", exact: true }).click();
	await page.getByRole("button", { name: recent ? `${basename(root)} ${root}` : "打开作品…", exact: true }).click();
	await page
		.getByRole("button", { name: "切换作品", exact: true })
		.filter({ hasText: basename(root) })
		.waitFor();
	assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).checkoutPath, root);
}

async function stored(page: Page, id: string): Promise<WorkspaceLayout> {
	return page.evaluate((project) => JSON.parse(window.localStorage.getItem(`suiming.${project}.view`) ?? "null"), id);
}

async function quit(app: ElectronApplication) {
	const closed = app.waitForEvent("close");
	await app.evaluate(({ app }) => {
		setTimeout(() => app.quit(), 0);
	});
	await closed;
}

test("多文件草稿：两部同路径作品往返、退出重开后内容与编辑位置隔离，单独保存不影响其他草稿", {
	timeout: 90000,
}, async () => {
	const { directory, roots, originals } = await fixture();
	let app: ElectronApplication | undefined = await launchDesktop({ directory, project: roots[0] });
	let lastPage: Page | undefined;
	const errors: string[] = [];
	const drafts: [Record<string, string>, Record<string, string>] = [{}, {}];
	const tabs: [Record<string, string>, Record<string, string>] = [{}, {}];
	const ids: [string, string] = ["", ""];
	try {
		let page = await app.firstWindow();
		lastPage = page;
		page.setDefaultTimeout(7000);
		let pageErrors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		for (const index of [0, 1] as const) {
			if (index === 1) await switchProject(app, page, roots[1]);
			ids[index] = (await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId;
			for (const path of targets) {
				const editor = await openFile(page, path);
				await page.keyboard.press("Meta+End");
				await page.keyboard.insertText(`作品${index}尚未保存：${path}。`);
				drafts[index][path] = await editorText(editor);
				const tabId = await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id");
				assert.ok(tabId);
				tabs[index][path] = tabId;
				await page.keyboard.press("Meta+Home");
				await page.keyboard.press("ArrowRight");
				await page.keyboard.press("ArrowRight");
				await page.keyboard.press("ArrowRight");
			}
			await page.getByRole("textbox", { name: "输入消息", exact: true }).fill(`作品${index}未发送要求`);
		}
		// 经过真实作品切换入口返回，不能用 bridge 直调绕过保存与弹层收尾。
		await switchProject(app, page, roots[0], true);
		const verify = async (index: 0 | 1) => {
			const editor = page.getByLabel("编辑文件内容", { exact: true });
			await eventually(() => focused(editor), "切换或重开恢复活动编辑器焦点");
			assert.equal(
				await page.getByRole("textbox", { name: "输入消息", exact: true }).inputValue(),
				`作品${index}未发送要求`,
			);
			for (const path of [...targets].reverse()) {
				const tab = page.locator(`[data-tab-id="${tabs[index][path]}"]`);
				if ((await tab.getAttribute("data-active")) !== "true") await tab.click();
				await eventually(() => focused(editor), "切页恢复编辑焦点");
				assert.equal(await editorText(editor), drafts[index][path]);
				const draft = drafts[index][path];
				assert.ok(draft);
				// 在保存的光标位置直接继续输入，再撤销本次输入；不是只看 localStorage 有字段。
				await page.keyboard.insertText("【续】");
				assert.equal(await editorText(editor), `${draft.slice(0, 3)}【续】${draft.slice(3)}`);
				await page.keyboard.press("Meta+z");
				assert.equal(await editorText(editor), drafts[index][path]);
				assert.equal(await readFile(join(roots[index], path), "utf8"), originals[index][path]);
			}
			const state = await stored(page, ids[index]);
			for (const path of targets) assert.equal(state.documents[path]?.content, drafts[index][path]);
			const shown = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
			assert.equal(shown.revisions.length, 1);
			assert.equal(shown.dirty, false);
		};
		await verify(0);
		errors.push(...pageErrors);
		await quit(app);
		app = undefined;
		app = await launchDesktop({ directory });
		page = await app.firstWindow();
		lastPage = page;
		page.setDefaultTimeout(7000);
		pageErrors = collectPageErrors(page);
		await page.getByLabel("编辑文件内容", { exact: true }).waitFor();
		await verify(0);
		await switchProject(app, page, roots[1], true);
		await verify(1);
		await page.keyboard.press("Meta+s");
		await page.getByText("已保存", { exact: true }).waitFor();
		assert.equal(await readFile(join(roots[1], targets[0]), "utf8"), drafts[1][targets[0]]);
		for (const path of targets.slice(1))
			assert.equal(await readFile(join(roots[1], path), "utf8"), originals[1][path]);
		for (const path of targets) assert.equal(await readFile(join(roots[0], path), "utf8"), originals[0][path]);
		await mkdir("/tmp/suiming-multi-draft-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-multi-draft-qa/reopened.png", animations: "disabled" });
		errors.push(...pageErrors);
		assert.deepEqual(errors, []);
	} catch (error) {
		console.error(await lastPage?.locator("body").innerText());
		await lastPage?.screenshot({ path: "/tmp/suiming-multi-draft-failure.png" });
		throw error;
	} finally {
		await app?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("多文件草稿存储失败：切换与退出可取消，恢复存储后关窗重开保留全部草稿", { timeout: 60000 }, async () => {
	const { directory, roots, originals } = await fixture();
	const app = await launchDesktop({ directory, project: roots[0] });
	let page = await app.firstWindow();
	page.setDefaultTimeout(7000);
	const errors = collectPageErrors(page);
	const drafts: Record<string, string> = {};
	const tabs: Record<string, string> = {};
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		for (const path of targets) {
			const editor = await openFile(page, path);
			await page.keyboard.press("Meta+End");
			await page.keyboard.insertText(`尚未保存：${path}。`);
			drafts[path] = await editorText(editor);
			const tabId = await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id");
			assert.ok(tabId);
			tabs[path] = tabId;
		}
		const id = (await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId;
		await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("也要保留这份对话草稿");
		// 注入浏览器草稿存储失败，文件写入和系统确认仍走产品路径。
		await page.evaluate(() => {
			const prototype = Object.getPrototypeOf(window.localStorage);
			const write = prototype.setItem;
			(globalThis as unknown as { restoreDraftStorage: () => void }).restoreDraftStorage = () => {
				prototype.setItem = write;
			};
			prototype.setItem = function (key: string, value: string) {
				if (key.startsWith("suiming.") && key.endsWith(".view")) throw new Error("草稿存储故障注入");
				return write.call(this, key, value);
			};
		});
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		await editor.click();
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("写入失败后新增的句子。");
		drafts[targets[2]] = await editorText(editor);
		await page.getByText("本机草稿存储空间不足，请保存当前编辑后再关闭窗口。", { exact: true }).waitFor();
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
		}, roots[1]);
		await page.getByRole("button", { name: "切换作品", exact: true }).click();
		await page.getByRole("button", { name: "打开作品…", exact: true }).click();
		await page.getByText("草稿存储故障注入", { exact: true }).waitFor();
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).projectId, id);
		await page.keyboard.press("Escape");
		await editor.click();
		page.on("dialog", () => undefined);
		await app.evaluate(({ dialog, app }) => {
			dialog.showMessageBoxSync = () => {
				(globalThis as unknown as { draftQuitCancelled: boolean }).draftQuitCancelled = true;
				return 0;
			};
			setTimeout(() => app.quit(), 0);
		});
		await eventually(
			() =>
				app.evaluate(() => (globalThis as unknown as { draftQuitCancelled?: boolean }).draftQuitCancelled === true),
			"原生退出确认选择继续编辑",
		);
		assert.equal(app.process().exitCode, null);
		await eventually(() => focused(editor), "取消退出仍在编辑器");
		assert.equal(await editorText(editor), drafts[targets[2]]);
		await page.evaluate(() => (globalThis as unknown as { restoreDraftStorage: () => void }).restoreDraftStorage());
		// 关窗口与退出进程不同：主进程仍存活，通过原生 activate 路径重新建窗。
		const closed = page.waitForEvent("close");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
		await closed;
		assert.equal(app.process().exitCode, null);
		const opened = app.waitForEvent("window");
		await app.evaluate(({ app }) => {
			app.emit("activate");
		});
		page = await opened;
		page.setDefaultTimeout(7000);
		const reopenedErrors = collectPageErrors(page);
		const restoredEditor = page.getByLabel("编辑文件内容", { exact: true });
		await eventually(() => focused(restoredEditor), "重开窗口聚焦原编辑器");
		assert.equal(
			await page.getByRole("textbox", { name: "输入消息", exact: true }).inputValue(),
			"也要保留这份对话草稿",
		);
		for (const path of [...targets].reverse()) {
			const tab = page.locator(`[data-tab-id="${tabs[path]}"]`);
			if ((await tab.getAttribute("data-active")) !== "true") await tab.click();
			await eventually(() => focused(restoredEditor), "逐页恢复焦点");
			assert.equal(await editorText(restoredEditor), drafts[path]);
			assert.equal(await readFile(join(roots[0], path), "utf8"), originals[0][path]);
		}
		const state = await stored(page, id);
		for (const path of targets) assert.equal(state.documents[path]?.content, drafts[path]);
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisions.length, 1);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 960);
		await mkdir("/tmp/suiming-multi-draft-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-multi-draft-qa/window-reopened-narrow.png", animations: "disabled" });
		assert.deepEqual([...errors, ...reopenedErrors], []);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBoxSync = () => 1;
			})
			.catch(() => undefined);
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
