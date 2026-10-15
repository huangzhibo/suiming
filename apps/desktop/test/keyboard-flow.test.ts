import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { Locator, Page } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const innerWidth: number;

const focused = (locator: Locator) => locator.evaluate((element) => element === element.ownerDocument.activeElement);
async function tabTo(page: Page, target: Locator) {
	for (let i = 0; i < 100; i++) {
		if (await focused(target)) return;
		await page.keyboard.press("Tab");
	}
	assert.fail("Tab 无法到达目标控件");
}
async function fixture(extraFiles = 0) {
	const directory = await mkdtemp(join(tmpdir(), "suiming-keyboard-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	for (let i = 1; i <= extraFiles; i++) {
		const title = `键盘样例${String(i).padStart(2, "0")}`;
		await writeFile(join(root, `intent/${title}.md`), `# ${title}\n\n仅供键盘规模验收。\n`);
	}
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(5000);
	const errors = collectPageErrors(page);
	await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
	await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
	return {
		root,
		app,
		page,
		errors,
		close: async () => {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test("键盘：新标签检索、编辑保存、返回查询与弹层退出", { timeout: 60000 }, async () => {
	const { root, page, errors, close } = await fixture();
	try {
		await page.keyboard.press("Meta+t");
		const search = page.getByRole("textbox", { name: "搜索对象或文件", exact: true });
		await search.waitFor();
		await eventually(() => focused(search), "新标签应直接聚焦搜索框");
		await page.keyboard.insertText("黄盖");
		await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
		assert.equal(await search.isVisible(), true);
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
		await page.keyboard.press("Meta+e");
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		await eventually(() => focused(editor), "进入编辑后直接输入");
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("\n键盘连续操作验收。\n");
		await page.keyboard.press("Meta+s");
		await eventually(
			async () => (await readFile(join(root, "world/characters/黄盖.md"), "utf8")).includes("键盘连续操作验收。"),
			"保存落盘",
		);
		await tabTo(page, page.getByRole("button", { name: "更多", exact: true }));
		await page.keyboard.press("Enter");
		await page.getByRole("menu").waitFor();
		await page.keyboard.press("Escape");
		await eventually(() => focused(page.getByRole("button", { name: "更多", exact: true })), "菜单退出回触发按钮");
		await tabTo(page, page.getByRole("button", { name: "后退", exact: true }));
		await page.keyboard.press("Enter");
		await search.waitFor();
		assert.equal(await search.inputValue(), "黄盖");
		await eventually(
			() => focused(page.locator('[data-scroll-key="empty"] [data-page="world/characters/黄盖.md"]')),
			"返回选择页恢复原结果焦点",
		);
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
		await page.keyboard.press("Meta+e");
		await editor.waitFor();
		assert.match(await editor.innerText(), /键盘连续操作验收/u);
		await page.reload();
		await editor.waitFor();
		assert.match(await editor.innerText(), /键盘连续操作验收/u);
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("键盘：侧栏搜索重复唤起、结果移动与输入法保护", { timeout: 60000 }, async () => {
	const { page, errors, close } = await fixture();
	try {
		await page.keyboard.press("Meta+k");
		const search = page.getByRole("textbox", { name: "搜索作品", exact: true });
		await eventually(() => focused(search), "搜索首次获得焦点");
		await page.keyboard.insertText("黄盖");
		const results = page.locator("#workbench-left [data-page]");
		await results.first().waitFor();
		await search.dispatchEvent("keydown", { key: "ArrowDown", isComposing: true });
		assert.equal(await focused(search), true);
		await page.keyboard.press("ArrowDown");
		await eventually(() => focused(results.first()), "下方向键进入搜索结果");
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
		await page.keyboard.press("Meta+e");
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		await eventually(() => focused(editor), "进入人物编辑");
		await page.keyboard.press("Meta+k");
		await eventually(() => focused(search), "搜索已展开时再次按快捷键仍转移焦点");
		await page.keyboard.press("Meta+a");
		await page.keyboard.insertText("beat-");
		await page.keyboard.press("ArrowDown");
		await eventually(() => focused(results.first()), "改变查询后从首项开始");
		await page.keyboard.press("ArrowDown");
		await eventually(() => focused(results.nth(1)), "结果间向下移动");
		await mkdir("/tmp/suiming-keyboard-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-keyboard-qa/search-focus.png" });
		await page.keyboard.press("Home");
		await eventually(() => focused(results.first()), "Home 回第一项");
		await page.keyboard.press("ArrowUp");
		await eventually(() => focused(search), "首项上方向键返回输入框");
		await page.keyboard.press("Meta+a");
		await page.keyboard.insertText("不存在的结果");
		await page.keyboard.press("Enter");
		assert.equal(await focused(search), true);
		await search.dispatchEvent("keydown", { key: "t", metaKey: true, isComposing: true });
		assert.equal(await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).count(), 0);
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("键盘：未保存关闭取消恢复光标，弹窗不穿透快捷键", { timeout: 60000 }, async () => {
	const { page, errors, close } = await fixture();
	try {
		await page.keyboard.press("Meta+e");
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		await eventually(() => focused(editor), "编辑器获得焦点");
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("\n未保存的键盘草稿。");
		await page.keyboard.press("Meta+w");
		const dialog = page.getByRole("dialog", { name: "保留未保存的修改？" });
		await dialog.waitFor();
		const before = await page.locator(".tab-btn").count();
		await page.keyboard.press("Meta+t");
		assert.equal(await page.locator(".tab-btn").count(), before);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		await eventually(() => focused(editor), "取消关闭回原编辑器");
		await page.keyboard.insertText("继续。");
		assert.match(await editor.innerText(), /未保存的键盘草稿。继续。/u);
		await page.keyboard.press("Meta+z");
		await page.keyboard.press("Meta+Shift+z");
		assert.match(await editor.innerText(), /未保存的键盘草稿。继续。/u);
		const settings = page.getByRole("button", { name: "设置", exact: true });
		await tabTo(page, settings);
		await page.keyboard.press("Enter");
		await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
		await page.keyboard.press("Escape");
		await eventually(() => focused(settings), "设置关闭后返回触发按钮");
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("键盘：窄窗搜索与保存冲突后取消仍保留编辑现场", { timeout: 60000 }, async () => {
	const { root, app, page, errors, close } = await fixture();
	try {
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => innerWidth === 960);
		await page.keyboard.press("Meta+k");
		const search = page.getByRole("textbox", { name: "搜索作品", exact: true });
		await eventually(() => focused(search), "窄窗直接进入左栏搜索");
		await page.keyboard.insertText("黄盖");
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
		await page.keyboard.press("Meta+e");
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		await eventually(() => focused(editor), "窄窗编辑器聚焦");
		await page.keyboard.press("Meta+End");
		await page.keyboard.insertText("\n尚未保存的修改。");
		const path = join(root, "world/characters/黄盖.md");
		const external = `${await readFile(path, "utf8")}\n外部修改。\n`;
		await writeFile(path, external);
		await page.keyboard.press("Meta+w");
		const dialog = page.getByRole("dialog", { name: "保留未保存的修改？" });
		await dialog.waitFor();
		await tabTo(page, dialog.getByRole("button", { name: "保存并继续", exact: true }));
		await page.keyboard.press("Enter");
		await dialog.getByRole("alert").waitFor();
		assert.equal(await readFile(path, "utf8"), external, "冲突不覆盖外部内容");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		await eventually(() => focused(editor), "保存失败取消后回到原编辑器");
		await page.keyboard.insertText("继续修订。");
		assert.match(await editor.innerText(), /尚未保存的修改。继续修订。/u);
		await page.reload();
		await editor.waitFor();
		assert.match(await editor.innerText(), /尚未保存的修改。继续修订。/u);
		await mkdir("/tmp/suiming-keyboard-qa", { recursive: true });
		await page.screenshot({ path: "/tmp/suiming-keyboard-qa/conflict-narrow.png" });
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("键盘：分屏切换到结果按钮不被搜索框抢焦点", { timeout: 60000 }, async () => {
	const { app, page, errors, close } = await fixture();
	try {
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 900));
		await page.waitForFunction(() => innerWidth === 1600);
		await page.keyboard.press("Meta+t");
		const search = page.getByRole("textbox", { name: "搜索对象或文件", exact: true });
		await eventually(() => focused(search), "打开空白页");
		await page.keyboard.insertText("黄盖");
		await tabTo(page, page.getByRole("button", { name: "更多", exact: true }));
		await page.keyboard.press("Enter");
		const split = page.getByRole("menuitem", { name: "左右分屏", exact: true });
		await split.waitFor();
		// 菜单原语用方向键移动；不直接 focus 或点击菜单项。
		for (let i = 0; i < 30 && !(await focused(split)); i++) await page.keyboard.press("ArrowDown");
		assert.equal(await focused(split), true);
		await page.keyboard.press("Enter");
		const panes = page.getByRole("region", { name: "文档窗格", exact: true });
		await eventually(async () => (await panes.count()) === 2, "创建两个文档窗格");
		const left = panes.nth(0);
		const right = panes.nth(1);
		const result = left.locator("[data-search-result]").first();
		await tabTo(page, result);
		await result.evaluate(
			(element) =>
				new Promise<void>((done) =>
					element.ownerDocument.defaultView?.requestAnimationFrame(() =>
						element.ownerDocument.defaultView?.requestAnimationFrame(() => done()),
					),
				),
		);
		assert.equal(await focused(result), true, "激活左窗格后焦点仍在刚遍历到的结果");
		await page.keyboard.press("Enter");
		await left.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
		assert.equal(await right.getByRole("textbox", { name: "搜索对象或文件", exact: true }).inputValue(), "黄盖");
		await left.getByRole("button", { name: "切换到编辑视图", exact: true }).waitFor();
		await page.keyboard.press("Meta+e");
		await eventually(() => focused(left.getByLabel("编辑文件内容", { exact: true })), "只编辑活动窗格");
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});

test("键盘：侧栏大量结果全部可达，展开后焦点落在新增条目", { timeout: 60000 }, async () => {
	const { page, errors, close } = await fixture(70);
	try {
		await page.keyboard.press("Meta+k");
		const search = page.getByRole("textbox", { name: "搜索作品", exact: true });
		await eventually(() => focused(search), "聚焦侧栏搜索");
		await page.keyboard.insertText("键盘样例");
		await page.getByText("已显示 60 / 70 个结果", { exact: true }).waitFor();
		const results = page.locator("#workbench-left [data-search-result]");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("End");
		await eventually(() => focused(results.nth(59)), "到达当前最后一项");
		await page.keyboard.press("Tab");
		assert.equal(await focused(page.getByRole("button", { name: "显示更多结果", exact: true })), true);
		await page.keyboard.press("Enter");
		await eventually(() => focused(results.nth(60)), "更多按钮消失后进入第一条新增结果");
		assert.equal(await results.count(), 70);
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "键盘样例70", exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await close();
	}
});
