import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { _electron as electron, type Locator } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import type { WorkspaceLayout } from "../../web/src/workspace-layout.js";

test("统一文档：文件树准确切换设计与正文，草稿分别保存，旧文件标签恢复且错误格式可修复", {
	timeout: 90000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-document-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const design = "outline/story/vol-0001/beat-0001.md";
	const prose = "text/beat-0001.md";
	const originalDesign = await readFile(join(root, design), "utf8");
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, prose), "原来的正文。");
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name: "在文件树中定位", exact: true }).click();
		await page.locator('[data-file-path="outline/story/index.yaml"]').click();
		await page.getByRole("navigation", { name: "文件路径" }).waitFor();
		await page.getByLabel("源文件内容", { exact: true }).filter({ hasText: "beat_ids:" }).waitFor();
		await page.locator(`[data-file-path="${design}"]`).click();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name: "在文件树中定位", exact: true }).click();
		const proseFile = page.locator(`[data-file-path="${prose}"]`);
		await proseFile.click();
		assert.equal(await page.locator(".tab-btn").count(), 1);
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").fill("未保存的正文草稿。");
		for (const name of ["outline", "story", "vol-0001"]) {
			const folder = page.getByRole("treeitem", { name, exact: true });
			if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
		}
		const designFile = page.locator(`[data-file-path="${design}"]`);
		await designFile.click();
		await page.getByRole("radio", { name: "设计", exact: true, checked: true }).waitFor();
		await page.locator(".cm-content").filter({ hasText: "黄盖当众顶撞" }).waitFor();
		const updatedDesign = `${originalDesign}\n设计补充。`;
		await page.locator(".cm-content").fill(updatedDesign);
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).waitFor({ state: "hidden" });
		await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, design), "utf8"), updatedDesign);
		assert.equal(await readFile(join(root, prose), "utf8"), "原来的正文。", "保存设计不能覆盖正文草稿");
		await proseFile.click();
		await page.getByRole("radio", { name: "正文", exact: true, checked: true }).waitFor();
		await page.locator(".cm-content").filter({ hasText: "未保存的正文草稿。" }).waitFor();
		assert.equal(await page.locator(".tab-btn").count(), 1);
		// 模拟已有用户保存的源文件标签，在启动时恢复同一份草稿。
		await page.addInitScript((prose) => {
			const key = Object.keys(localStorage).find((key) => key.startsWith("suiming.") && key.endsWith(".view"));
			if (!key) return;
			const layout = JSON.parse(localStorage.getItem(key) ?? "null") as WorkspaceLayout;
			const group = layout.groups.find((group) => group.id === layout.activeGroup);
			const tab = group?.tabs[group.active];
			if (tab) tab.location.page = `file:${prose}`;
			localStorage.setItem(key, JSON.stringify(layout));
		}, prose);
		await page.reload();
		await page.getByRole("navigation", { name: "作品位置" }).waitFor();
		await page.locator(".cm-content").filter({ hasText: "未保存的正文草稿。" }).waitFor();
		assert.equal(await page.locator(".tab-btn").count(), 1);
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).waitFor({ state: "hidden" });
		await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, prose), "utf8"), "未保存的正文草稿。");
		// 路径能识别但 frontmatter 损坏时，仍能看到诊断并进入同一编辑器修复。
		await writeFile(join(root, design), "---\ntitle: [未闭合\n---\n仍可修复。");
		await designFile.click();
		await page.getByRole("button", { name: "切换到阅读视图", exact: true }).click();
		await page.getByText(/可切换到编辑视图修复/).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").filter({ hasText: "title: [未闭合" }).waitFor();
		await page.locator(".cm-content").fill(originalDesign);
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).waitFor({ state: "hidden" });
		await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, design), "utf8"), originalDesign);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("内容意图与通用分屏：空正文回退、独立导航、共享草稿、合并和重载", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-modes-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "黄盖推开赤壁的大门。\n\n".repeat(80));
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const pane = () => page.locator('[data-pane-active="true"]');
	const mode = async (target: Locator, name: "设计" | "正文") => {
		const radio = target.getByRole("radio", { name, exact: true });
		if (await radio.isVisible()) await radio.click();
		else {
			await target.getByRole("button", { name: "内容视图", exact: true }).click();
			await page.getByRole("menuitemradio", { name, exact: true }).click();
		}
	};
	const menu = async (target: Locator, name: string) => {
		await target.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name, exact: true }).click();
	};
	const selectBeat = async (id: string) => page.locator(`.beat-row[data-page$="${id}.md"]`).click();
	try {
		await pane().getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		assert.equal(await pane().getByRole("radio", { name: "设计", exact: true }).getAttribute("aria-checked"), "true");
		await pane().locator("[data-relations]").waitFor();
		await pane().locator("[data-properties]").waitFor();
		const properties = pane().locator("[data-properties]");
		assert.ok(await properties.locator("dt").count());
		assert.equal(await properties.getByText("title", { exact: true }).count(), 0);
		await properties.locator("summary").click();
		assert.equal(await properties.locator("dl").isVisible(), false, "属性可折叠，保留正文阅读空间");
		await properties.locator("summary").focus();
		await page.keyboard.press("Enter");
		assert.equal(await properties.locator("dl").isVisible(), true, "键盘可展开属性");
		await selectBeat("beat-0002");
		assert.equal(await pane().getByRole("radio", { name: "设计", exact: true }).getAttribute("aria-checked"), "true");
		await selectBeat("beat-0001");
		await mode(pane(), "正文");
		await pane().locator("[data-prose]").waitFor();
		assert.equal(await pane().locator("[data-relations]").count(), 0, "正文不附带设计关系图");
		assert.equal(await pane().locator("[data-properties]").count(), 0);
		assert.equal(await pane().locator("article").getByText("text/beat-0001.md", { exact: true }).count(), 0);
		// 阅读 / 编辑切换共用同一文档，不再提供重复的源文件入口。
		await pane().getByRole("button", { name: "更多", exact: true }).click();
		assert.equal(await page.getByRole("menuitem", { name: "查看源文件", exact: true }).count(), 0);
		assert.equal(await page.getByRole("menuitem", { name: "查看对应作品对象", exact: true }).count(), 0);
		await page.keyboard.press("Escape");
		await pane().getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await pane().locator(".cm-content").filter({ hasText: "黄盖推开赤壁的大门。" }).waitFor();
		await pane().getByRole("button", { name: "切换到阅读视图", exact: true }).click();
		await pane().locator("[data-prose]").waitFor();
		assert.equal(await page.locator(".tab-btn").count(), 1);
		assert.equal(await pane().locator("[data-relations]").count(), 0);
		await selectBeat("beat-0002");
		await pane().getByRole("radio", { name: "设计", exact: true, checked: true }).waitFor();
		await pane().getByText("尚无正文", { exact: true }).waitFor();
		assert.equal(
			await pane().getByText("此情节还没有正文，当前展示设计。", { exact: false }).count(),
			0,
			"正常的空正文回退不显示额外提示",
		);
		await selectBeat("beat-0001");
		await pane().locator("[data-prose]").waitFor();
		await pane().getByRole("button", { name: "后退", exact: true }).click();
		await pane().getByRole("radio", { name: "设计", exact: true, checked: true }).waitFor();
		await pane().getByText("尚无正文", { exact: true }).waitFor();
		await mode(pane(), "正文");
		await pane().getByText("正文尚未开始。", { exact: false }).waitFor();
		assert.equal(await pane().locator("[data-relations]").count(), 0, "空正文也不显示设计关系图");
		await menu(pane(), "并排查看设计与正文");
		assert.equal(await page.locator("[data-pane-id]").count(), 2);
		const designId = await page.locator("[data-pane-id]").first().getAttribute("data-pane-id");
		const textId = await pane().getAttribute("data-pane-id");
		const design = page.locator(`[data-pane-id="${designId}"]`);
		const text = page.locator(`[data-pane-id="${textId}"]`);
		await design.locator("[data-relations]").waitFor();
		assert.equal(await text.locator("[data-relations]").count(), 0, "分屏时关系仅出现在设计一侧");
		await text.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await text.locator(".cm-content").fill("第一份草稿。\n第二段。");
		await menu(text, "上下分屏");
		assert.equal(await page.locator("[data-pane-id]").count(), 3);
		const copyId = await pane().getAttribute("data-pane-id");
		const copy = page.locator(`[data-pane-id="${copyId}"]`);
		await copy.locator(".cm-content").filter({ hasText: "第一份草稿" }).waitFor();
		await copy.locator(".cm-content").fill("两边共享的最终草稿。");
		await text.locator(".cm-content").filter({ hasText: "两边共享的最终草稿" }).waitFor();
		await copy.getByRole("button", { name: "切换到阅读视图", exact: true }).click();
		await copy.locator("[data-prose]").filter({ hasText: "两边共享的最终草稿" }).waitFor();
		await design.getByRole("navigation", { name: "作品位置", exact: true }).click();
		await selectBeat("beat-0001");
		await design.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		assert.match(await text.getByRole("navigation", { name: "作品位置", exact: true }).innerText(), /beat-0002/);
		const handle = page.getByRole("separator", { name: "调整分屏高度", exact: true });
		await handle.focus();
		await page.keyboard.press("ArrowUp");
		await page.reload();
		await page.locator("[data-pane-id]").nth(2).waitFor();
		await text.locator(".cm-content").filter({ hasText: "两边共享的最终草稿" }).waitFor();
		await copy.locator("[data-prose]").filter({ hasText: "两边共享的最终草稿" }).waitFor();
		await menu(copy, "合并到相邻窗格");
		assert.equal(await page.locator("[data-pane-id]").count(), 2);
		assert.equal(await page.locator(".tab-btn").count(), 4, "设计页也保护同一情节的未保存稿，合并不丢弃标签");
		await pane().getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await pane().getByText("已保存，尚未提交", { exact: true }).waitFor();
		assert.match(await readFile(join(root, "text/beat-0002.md"), "utf8"), /两边共享的最终草稿/);
		await pane().getByRole("button", { name: "关闭标签", exact: true }).click();
		await pane().getByRole("button", { name: "关闭标签", exact: true }).click();
		assert.equal(await page.locator("[data-pane-id]").count(), 1);
		assert.equal(await page.getByRole("dialog").count(), 0);
		await menu(pane(), "左右分屏");
		await menu(pane(), "左右分屏");
		await page.getByText("窗口较小，暂时显示当前窗格", { exact: true }).waitFor();
		assert.equal(await page.locator("[data-pane-id]").count(), 1);
		await page.getByRole("button", { name: "切换到窗格 1", exact: true }).click();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(2000, 940));
		await page.locator("[data-pane-id]").nth(2).waitFor();
		assert.equal(await page.getByText("窗口较小，暂时显示当前窗格", { exact: true }).count(), 0);
		await selectBeat("beat-0002");
		await mode(pane(), "正文");
		await menu(pane(), "查看版本记录");
		await pane().getByText("当前文件在这个版本没有变更", { exact: true }).waitFor();
		await pane().getByRole("button", { name: "选择作品版本", exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} catch (error) {
		console.log("modes failure", errors, await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
