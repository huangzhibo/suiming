import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

declare const document: { querySelector(selector: string): { scrollTop: number } | null };

test("独立版本比较：单栏与并排、共享草稿、固定基线、撤销、布局偏好与重载", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-comparison-"));
	const root = join(directory, "work");
	const target = "intent/计谋的代价.md";
	const original = `开场：初稿。\n\n${Array.from({ length: 80 }, (_, i) => `第${i + 1}段，黄盖推开赤壁的大门，准备承担揭开诈降。\n\n`).join("")}结尾：初稿。\n`;
	const committed = original.replace("开场：初稿。", "开场：第二版。");
	const draft = committed.replace("开场：第二版。", "开场：草稿。").replace("结尾：初稿。", "结尾：草稿。");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(
		root,
		sampleWorkFiles().map((file) =>
			file.path === target ? { ...file, bytes: new TextEncoder().encode(original) } : file,
		),
	);
	const project = await LocalProjectService.init({ checkoutPath: root });
	await writeFile(join(root, target), committed);
	await project.commitCheckout();
	project.close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const menu = async (name: string) => {
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name, exact: true }).click();
	};
	const activateOriginal = async () =>
		page.locator(".tab-btn").first().getByRole("button", { name: "计谋的代价", exact: true }).click();
	const right = page.locator(".cm-merge-b .cm-content");
	const left = page.locator(".cm-merge-a .cm-content");
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	const snapshot = () =>
		page.evaluate(() => JSON.parse(Object.values(localStorage).find((value) => value.includes('"groups"')) ?? "{}"));
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "材料", exact: true }).click();
		await page.getByRole("button", { name: /计谋的代价/ }).click();
		await menu("查看版本差异");
		await page.getByText("没有未提交修改", { exact: true }).waitFor();
		assert.equal(await page.locator(".tab-btn").count(), 2);
		assert.equal(await left.getAttribute("contenteditable"), "false");
		assert.equal(await right.getAttribute("contenteditable"), "true");
		assert.equal(await page.getByRole("button", { name: "返回原视图", exact: true }).count(), 0);
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await editor.fill(draft);
		await page.keyboard.press("Control+Home");
		await menu("查看版本差异");
		await page.getByText(/2 处差异/, { exact: false }).waitFor();
		await activateOriginal();
		assert.equal((await snapshot()).documents[target].content, draft);
		await menu("查看版本差异");
		assert.equal(await page.locator(".tab-btn").count(), 2, "重复打开激活已有比较");
		await right.waitFor();
		const currentNode = await right.elementHandle();
		await page.getByRole("button", { name: "选择比较基线", exact: true }).click();
		await page.getByRole("menuitemradio", { name: "r1", exact: true }).click();
		await left.getByText("开场：初稿。", { exact: true }).waitFor();
		assert.equal(await currentNode?.evaluate((node) => node.isConnected), true, "换基线不重建右侧编辑器");
		assert.equal((await snapshot()).documents[target].content, draft);
		await page.getByRole("button", { name: "下一处差异", exact: true }).click();
		await page.getByRole("button", { name: "还原当前差异", exact: true }).click();
		await page.getByText(/1 处差异/, { exact: false }).waitFor();
		assert.notEqual((await snapshot()).documents[target].content, draft);
		await page.keyboard.press("Meta+z");
		await page.getByText(/2 处差异/, { exact: false }).waitFor();
		assert.equal((await snapshot()).documents[target].content, draft, "逐块还原写入可撤销的草稿");
		const handle = page.getByRole("separator", { name: "调整比较宽度", exact: true });
		await handle.focus();
		await page.keyboard.press("ArrowRight");
		assert.equal(await handle.getAttribute("aria-valuenow"), "52");
		const bounds = await handle.boundingBox();
		assert.ok(bounds);
		await page.mouse.move(bounds.x, bounds.y + 80);
		await page.mouse.down();
		await page.mouse.move(bounds.x + 60, bounds.y + 80);
		await page.mouse.up();
		assert.ok(Number(await handle.getAttribute("aria-valuenow")) > 52);
		assert.equal(await currentNode?.evaluate((node) => node.isConnected), true);
		await page.locator(".cm-merge-a .cm-scroller").evaluate((element) => {
			element.scrollTop = 800;
		});
		await page.waitForFunction(
			() =>
				Math.abs(
					(document.querySelector(".cm-merge-a .cm-scroller")?.scrollTop ?? 0) -
						(document.querySelector(".cm-merge-b .cm-scroller")?.scrollTop ?? 0),
				) < 2,
		);
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitemcheckbox", { name: "联动滚动", exact: true }).click();
		// 勾选项点了不收起菜单（Base UI 的默认，连着切几个开关不用反复打开），用 Esc 关掉。
		await page.keyboard.press("Escape");
		await page.locator(".cm-merge-a .cm-scroller").evaluate((element) => {
			element.scrollTop = 1200;
		});
		await page.waitForFunction(
			() =>
				Math.abs(
					(document.querySelector(".cm-merge-a .cm-scroller")?.scrollTop ?? 0) -
						(document.querySelector(".cm-merge-b .cm-scroller")?.scrollTop ?? 0),
				) > 200,
		);
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitemcheckbox", { name: "仅显示差异附近内容", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.locator(".cm-collapsedLines").first().waitFor();
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitemcheckbox", { name: "仅显示差异附近内容", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.locator(".cm-collapsedLines").first().waitFor({ state: "hidden" });
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 760));
		await page.locator('.cm-host[data-layout="unified"]').waitFor();
		assert.equal(await page.locator(".cm-editor").count(), 1, "窄窗自动使用单栏，旧内容以只读块展示");
		assert.equal(await handle.count(), 0);
		assert.equal((await snapshot()).documents[target].content, draft);
		await editor.focus();
		await page.keyboard.press("Meta+Shift+z");
		await page.getByText(/1 处差异/, { exact: false }).waitFor();
		assert.notEqual((await snapshot()).documents[target].content, draft, "切为单栏仍能重做此前的还原");
		await page.getByRole("button", { name: "切换为并排差异", exact: true }).click();
		await handle.waitFor();
		await editor.focus();
		await page.keyboard.press("Meta+z");
		await page.getByText(/2 处差异/, { exact: false }).waitFor();
		assert.equal((await snapshot()).documents[target].content, draft, "返回并排后撤销历史仍连续");
		await page.reload();
		await handle.waitFor();
		assert.equal(await page.locator(".cm-editor").count(), 2, "窄窗重载保留手动并排选择");
		await page.getByRole("button", { name: "切换为单栏差异", exact: true }).click();
		await page.locator('.cm-host[data-layout="unified"]').waitFor();
		await page.getByRole("button", { name: "选择比较基线", exact: true }).click();
		await page.getByRole("menuitemradio", { name: "r2 · 最新提交", exact: true }).click();
		await page.getByRole("button", { name: "上一处差异", exact: true }).click();
		await page.locator(".cm-deletedChunk").filter({ hasText: "开场：第二版" }).waitFor();
		await page.getByRole("button", { name: "还原当前差异", exact: true }).click();
		await page.getByText(/1 处差异/, { exact: false }).waitFor();
		assert.match((await snapshot()).documents[target].content, /^开场：第二版/, "单栏使用所选基线逐块还原");
		await page.keyboard.press("Meta+z");
		await page.getByText(/2 处差异/, { exact: false }).waitFor();
		await editor.focus();
		await page.keyboard.insertText("单栏续写");
		assert.match((await snapshot()).documents[target].content, /单栏续写/);
		assert.ok(!(await snapshot()).documents[target].content.includes("开场：第二版"), "只读旧文不混进当前编辑");
		await page.keyboard.press("Meta+z");
		assert.equal((await snapshot()).documents[target].content, draft);
		await page.getByRole("button", { name: "更多", exact: true }).click();
		assert.equal(await page.getByRole("menuitemcheckbox", { name: "联动滚动", exact: true }).count(), 0);
		await page.getByRole("menuitemcheckbox", { name: "仅显示差异附近内容", exact: true }).click();
		await page
			.locator(".cm-collapsedLines")
			.filter({ hasText: /^已折叠 .* 行未修改内容$/ })
			.first()
			.waitFor();
		await page.keyboard.press("Escape");
		await page.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: "detached" });
		await page.getByRole("button", { name: "更多", exact: true }).blur();
		await page.mouse.move(10, 10);
		await page.getByRole("tooltip").waitFor({ state: "hidden" });
		await page.screenshot({ path: "/tmp/suiming-comparison-unified-narrow.png" });
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000));
		await page.locator('.cm-host[data-layout="unified"]').waitFor();
		assert.equal(await page.locator(".cm-editor").count(), 1, "放宽不覆盖手动单栏偏好");
		await page.getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitemradio", { name: "跟随窗口宽度", exact: true }).click();
		await handle.waitFor();
		await page.getByRole("button", { name: "选择比较基线", exact: true }).click();
		await page.getByRole("menuitemradio", { name: "r1", exact: true }).click();
		await page.reload();
		await right.waitFor();
		assert.equal((await snapshot()).documents[target].content, draft);
		assert.match(await page.getByRole("button", { name: "选择比较基线", exact: true }).innerText(), /r1/);
		assert.ok(Number(await handle.getAttribute("aria-valuenow")) > 52);
		await page.screenshot({ path: "/tmp/suiming-comparison-split-wide.png" });
		const frozen = (await snapshot()).groups[0].tabs[1].location.diffRevision;
		await page.getByRole("button", { name: "保存 ⌘S", exact: true }).click();
		await page.getByText("已保存，尚未提交", { exact: true }).waitFor();
		assert.equal(await readFile(join(root, target), "utf8"), draft);
		await page.getByRole("button", { name: "提交版本", exact: true }).click();
		await page.getByText("已提交一个新版本", { exact: true }).waitFor();
		assert.equal((await snapshot()).groups[0].tabs[1].location.diffRevision, frozen, "新提交不移动比较基线");
		await page.getByRole("button", { name: "关闭标签", exact: true }).click();
		await editor.waitFor();
		assert.equal(await page.locator(".tab-btn").count(), 1);
		// CodeMirror 只渲染视口附近行；提交后的干净文档也不再保留草稿记录。先核对文件，再定位末段。
		assert.equal(await readFile(join(root, target), "utf8"), draft, "关闭比较后完整已提交文档保持不变");
		await editor.focus();
		await page.keyboard.press("Meta+End");
		await editor.getByText("结尾：草稿。", { exact: true }).waitFor();
		assert.equal(await page.getByRole("dialog").count(), 0);
		assert.deepEqual(errors, []);
	} catch (error) {
		console.error(errors, await page.locator("body").innerText());
		await page.screenshot({ path: "/tmp/suiming-comparison-failure.png" });
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
