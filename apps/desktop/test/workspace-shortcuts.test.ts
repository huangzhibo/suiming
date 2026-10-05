import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

test("快捷键 ⌘T / ⌘W / ⌘E / ⌘S / ⌘K、关标签时「保存并继续」、选段「询问 Agent」", { timeout: 60000 }, async () => {
	// 2026-10-06 拆 WorkspaceSurface 时补：这几处原来没有 E2E，快捷键处理从一个函数挪进了文档窗格组件。
	const directory = await mkdtemp(join(tmpdir(), "suiming-shortcuts-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "军杖落到第三十下。黄盖咬住了衣角。\n\n他一声没吭。\n");
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const tabs = page.locator(".tab-btn");
	const editor = page.locator(".cm-editor .cm-content");
	const unsaved = page.getByText("未保存", { exact: true });
	const text = () => readFile(join(root, "text/beat-0001.md"), "utf8");
	try {
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		const body = page.locator('[data-scroll-key="body:text"]');
		await body.locator("p").first().waitFor();
		const opened = await tabs.count();

		await page.keyboard.press("ControlOrMeta+t");
		await eventually(async () => (await tabs.count()) === opened + 1, "⌘T 开一个新标签");
		await page.keyboard.press("ControlOrMeta+w");
		await eventually(async () => (await tabs.count()) === opened, "⌘W 关掉它");
		await tabs.filter({ hasText: "beat-0001" }).first().waitFor();

		// ⌘E 进编辑，改一个字，⌘S 存盘；再按 ⌘E 回到阅读
		await page.keyboard.press("ControlOrMeta+e");
		await editor.click();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("周瑜转过身去。");
		await unsaved.waitFor();
		await page.keyboard.press("ControlOrMeta+s");
		await unsaved.waitFor({ state: "hidden" });
		assert.match(await text(), /周瑜转过身去。/);
		await page.keyboard.press("ControlOrMeta+e");
		await editor.waitFor({ state: "hidden" });
		await body.locator("p").first().waitFor();

		// 有未保存修改时 ⌘W：确认框里「保存并继续」先存盘再关
		await page.keyboard.press("ControlOrMeta+e");
		await editor.click();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("鼓声停了。");
		await unsaved.waitFor();
		await page.keyboard.press("ControlOrMeta+w");
		const dialog = page.getByRole("dialog", { name: "保留未保存的修改？" });
		await dialog.getByText("text/beat-0001.md", { exact: true }).waitFor();
		await dialog.getByRole("button", { name: "保存并继续", exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		assert.match(await text(), /鼓声停了。/);
		assert.equal(await tabs.filter({ hasText: "beat-0001" }).count(), 0, "保存后标签照常关掉");

		// 选段「询问 Agent」：选段成为输入框里的引用，右栏切到对话，选段栏收起
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await body.locator("p").first().waitFor();
		await body.evaluate((element) => {
			const node = element.querySelector("p")?.firstChild;
			if (node) element.ownerDocument.getSelection()?.setBaseAndExtent(node, 0, node, 4);
		});
		await page.getByRole("button", { name: "询问 Agent", exact: true }).click();
		await page.getByRole("button", { name: "查看引用内容", exact: true }).waitFor();
		await page.getByRole("textbox", { name: "说明要怎么改", exact: true }).waitFor({ state: "hidden" });

		// ⌘K 打开左栏搜索
		await page.keyboard.press("ControlOrMeta+k");
		await page.getByRole("textbox", { name: "搜索作品", exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
