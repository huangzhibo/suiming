import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop, openGate } from "./launch.js";

declare const window: { suiming: DesktopBridge };

test("首次打开：正常欢迎页不报错，误选目录仍展示原因，随后可以创建作品", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-welcome-"));
	const invalid = join(directory, "ordinary");
	const fresh = join(directory, "new-work");
	await mkdir(invalid);
	await mkdir(fresh);
	await writeFile(join(invalid, "notes.txt"), "普通文件夹");
	const app = await launchDesktop({ directory });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	try {
		await page.getByRole("button", { name: "开始新作", exact: true }).waitFor();
		assert.equal(await page.getByText("请先打开或创建作品", { exact: true }).count(), 0);
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, invalid);
		await page.getByRole("button", { name: "打开作品 ↗", exact: true }).click();
		await page.getByRole("alert").waitFor();
		assert.ok((await page.getByRole("alert").innerText()).length > 0);
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, fresh);
		await page.getByRole("button", { name: "开始新作", exact: true }).click();
		await page.getByRole("textbox", { name: "输入消息", exact: true }).waitFor();
		assert.equal(await page.getByRole("button", { name: "开始新作", exact: true }).count(), 0);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("未配置模型发送被拒绝：文字与引用退回可编辑草稿，重载保留，可直接打开设置", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-send-rejected-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--unconfigured-model-test"] });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("button", { name: "添加内容", exact: true }).click();
		await page.getByRole("menuitem", { name: "引用当前文档", exact: true }).click();
		await page.getByRole("button", { name: "查看引用内容", exact: true }).waitFor();
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		await input.fill("请检查这一幕的因果，不修改作品。");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByRole("alert").filter({ hasText: "未发送" }).waitFor();
		assert.equal(await input.inputValue(), "请检查这一幕的因果，不修改作品。");
		assert.equal(await page.getByRole("button", { name: "查看引用内容", exact: true }).count(), 1);
		assert.equal(await page.getByRole("button", { name: "确认发送结果", exact: true }).count(), 0);
		assert.equal(await page.getByRole("button", { name: "对话模型", exact: true }).isEnabled(), true);
		assert.equal((await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions.length, 0);
		await page.reload();
		await input.waitFor();
		assert.equal(await input.inputValue(), "请检查这一幕的因果，不修改作品。");
		assert.equal(await page.getByRole("button", { name: "查看引用内容", exact: true }).count(), 1);
		await page.getByRole("button", { name: "配置模型", exact: true }).click();
		await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("长篇工作面：故事轴适应全书，人物介绍先于轨迹，展开选择重载保留", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-long-axis-"));
	const root = join(directory, "work");
	await cp(resolve("examples/sanguo"), root, { recursive: true });
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	try {
		await page.getByRole("button", { name: "打开故事轴", exact: true }).click();
		const columns = page.locator("[data-beat]");
		await columns.last().waitFor();
		assert.equal(await columns.count(), 231);
		const fits = () =>
			page.locator("[data-axis-scroll]").evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
		assert.equal(await fits(), true, "适应窗口不能仍有横向溢出");
		await page.getByRole("button", { name: "放大", exact: true }).click();
		await page.getByRole("button", { name: "适应窗口", exact: true }).click();
		assert.equal(await fits(), true);
		const last = await columns.last().boundingBox();
		const viewport = await page.locator("[data-axis-scroll]").boundingBox();
		assert.ok(last && viewport && last.x + last.width <= viewport.x + viewport.width + 1);
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "搜索", exact: true }).click();
		await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill("world/characters/刘备.md");
		await page.locator('.item-btn[data-page="world/characters/刘备.md"]').click();
		await page.getByRole("heading", { name: "刘备", exact: true }).waitFor();
		const relations = page.locator("[data-character-relations]");
		await relations.waitFor();
		assert.equal(await page.locator("[data-neighborhood]").count(), 0, "人物文档引用图默认按需展开");
		await relations.locator("summary").click();
		await page.locator("[data-neighborhood]").waitFor();
		await page.reload();
		await page.locator("[data-neighborhood]").waitFor();
		await relations.locator("summary").click();
		const intro = page.locator(".document-page .design-body").first();
		const track = page.locator("[data-character-track]");
		await track.waitFor();
		assert.equal(await track.getAttribute("open"), null);
		const introBox = await intro.boundingBox();
		const trackBox = await track.boundingBox();
		assert.ok(introBox && trackBox && introBox.y + introBox.height <= trackBox.y, "人物介绍必须先于全书轨迹");
		await track.locator("summary").click();
		await page.getByRole("img", { name: "人物轨迹", exact: true }).waitFor();
		await page.reload();
		await page.getByRole("img", { name: "人物轨迹", exact: true }).waitFor();
		await track.locator("summary").click();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.getByRole("button", { name: "展开左栏", exact: true }).waitFor();
		const narrowIntro = await intro.boundingBox();
		assert.ok(narrowIntro && narrowIntro.y < 400, "窄窗首屏应呈现人物介绍");
		await page.getByRole("button", { name: "展开左栏", exact: true }).click();
		await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill("intent/book.md");
		await page.locator('.item-btn[data-page="intent/book.md"]').click();
		await page.locator(".document-page .design-body").waitFor();
		assert.equal(await page.locator("[data-relations]").count(), 0, "无关系的意图文档不渲染空图");
		await page.getByRole("button", { name: "检查", exact: true }).click();
		await page.getByRole("button", { name: "查看详情", exact: true }).click();
		await page.getByRole("radio", { name: "警告 437", exact: true }).click();
		const diagnosticFilter = page.getByRole("textbox", { name: "筛选诊断" });
		await diagnosticFilter.fill("beat-0001.md");
		await page.getByText("显示 1 / 437 条", { exact: true }).waitFor();
		await page.reload();
		await page.getByText("显示 1 / 437 条", { exact: true }).waitFor();
		assert.equal(await diagnosticFilter.inputValue(), "beat-0001.md");
		await page.getByRole("radio", { name: "错误 0", exact: true }).click();
		await page.getByText("没有符合筛选条件的诊断。", { exact: true }).waitFor();
		await page.getByRole("button", { name: "清除筛选", exact: true }).click();
		await page.getByText("显示 437 / 437 条", { exact: true }).waitFor();

		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("历史版本：加载不误报空态，读取失败可重试，窄窗单栏且两侧只读", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-version-page-"));
	const root = join(directory, "work");
	const target = "intent/计谋的代价.md";
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root });
	const original = await readFile(join(root, target), "utf8");
	const committed = `${original}\n让选择的代价清楚可见。\n`;
	await writeFile(join(root, target), committed);
	await writeFile(
		join(root, "world/core.md"),
		`${await readFile(join(root, "world/core.md"), "utf8")}\n新增的版本核对标记。\n`,
	);
	await project.commitCheckout();
	project.close();
	const app = await launchDesktop({ directory, project: root, flags: ["--version-page-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "材料", exact: true }).click();
		await page.getByRole("button", { name: /^r2 ·/ }).click();
		await page.getByRole("heading", { name: "正在读取…", exact: true }).waitFor();
		assert.equal(await page.getByText("这个版本与父版本内容相同。", { exact: true }).count(), 0);
		await openGate(app, "version-list");
		await page.getByText("测试：版本清单读取失败", { exact: true }).waitFor();
		await page.getByRole("button", { name: "重新读取版本", exact: true }).click();
		await page.getByRole("alert").filter({ hasText: "测试：版本正文读取失败" }).waitFor();
		await page.getByRole("button", { name: "重新读取正文", exact: true }).click();
		await page.locator('.cm-host[data-layout="split"]').waitFor();
		const toolbar = await page.locator(".document-toolbar").boundingBox();
		const body = await page.locator(".cm-scroller").first().boundingBox();
		assert.ok(toolbar && body && body.y - toolbar.y - toolbar.height <= 88, "版本上下文应在两行内，尽快进入比较正文");
		await page.getByRole("button", { name: "下一处差异", exact: true }).click();
		assert.equal(await page.getByRole("button", { name: "还原当前差异", exact: true }).count(), 0);
		await page.getByRole("button", { name: "选择变更文件", exact: true }).click();
		await page.getByRole("combobox", { name: "搜索变更文件", exact: true }).fill("不存在的路径");
		await page.getByText("没有匹配的变更文件", { exact: true }).waitFor();
		await page.getByRole("combobox", { name: "搜索变更文件", exact: true }).fill("world/core.md");
		await page.getByRole("option", { name: /world\/core.md/ }).click();
		await page.locator(".cm-merge-b .cm-content").filter({ hasText: "新增的版本核对标记。" }).waitFor();
		await page.reload();
		await page.locator(".cm-merge-b .cm-content").filter({ hasText: "新增的版本核对标记。" }).waitFor();
		await page.getByRole("button", { name: "选择变更文件", exact: true }).click();
		await page.getByRole("combobox", { name: "搜索变更文件", exact: true }).fill(target);
		await page.getByRole("option", { name: new RegExp(target) }).click();
		await page.locator(".cm-merge-b .cm-content").filter({ hasText: "让选择的代价清楚可见。" }).waitFor();
		assert.equal(await page.locator('.cm-content[contenteditable="true"]').count(), 0);
		assert.equal(
			(await page.locator(".cm-merge-a .cm-line").allTextContents()).join("\n").trimEnd(),
			original.trimEnd(),
		);
		assert.equal(
			(await page.locator(".cm-merge-b .cm-line").allTextContents()).join("\n").trimEnd(),
			committed.trimEnd(),
		);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.locator('.cm-host[data-layout="unified"]').waitFor();
		assert.equal(await page.locator(".cm-editor").count(), 1);
		assert.equal(await page.locator('.cm-content[contenteditable="true"]').count(), 0);
		assert.ok((await page.locator(".cm-content").innerText()).includes("让选择的代价清楚可见。"));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1460, 940));
		await page.locator('.cm-host[data-layout="split"]').waitFor();
		assert.equal(await page.locator('.cm-content[contenteditable="true"]').count(), 0);
		assert.equal(await readFile(join(root, target), "utf8"), committed);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
