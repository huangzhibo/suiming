import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { Locator } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

// 全屏取决于宿主的原生窗口状态；独立验收，失败不得挡住普通窗口的导航、草稿和调宽回归。
test("macOS 原生全屏：导航入口、窗口按钮避让、重载与退出恢复", {
	timeout: 60000,
	skip: process.platform !== "darwin",
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-fullscreen-desktop-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const left = page.getByRole("separator", { name: "调整左栏宽度", exact: true });
	const outline = page.getByRole("button", { name: "大纲", exact: true });
	const drag = async (handle: Locator, delta: number) => {
		const box = await handle.boundingBox();
		assert.ok(box);
		await page.mouse.move(box.x + box.width / 2, box.y + 140);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + delta, box.y + 140, { steps: 8 });
		await page.mouse.up();
	};
	const aligned = async (side: "left") => {
		const header = await page.locator(`[data-pane-header='${side}']`).boundingBox();
		const pane = await page.locator(`#workbench-${side}`).boundingBox();
		const handle = await left.boundingBox();
		assert.ok(header && pane && handle);
		assert.equal(header.x, pane.x);
		assert.equal(header.width, pane.width);
		assert.equal(handle.y, header.y);
		assert.equal(handle.y + handle.height, pane.y + pane.height);
	};
	try {
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await app.evaluate(({ BrowserWindow, app: desktopApp }) => {
			desktopApp.focus({ steal: true });
			BrowserWindow.getAllWindows()[0]?.focus();
		});
		await drag(left, -22);
		await page.getByRole("button", { name: "切换导航：大纲", exact: true }).waitFor();
		const fullscreen = async (value: boolean) => {
			// macOS 的全屏切换是 Space 动画，宿主状态不对时 enter/leave-full-screen 可能永远不来。
			// 无界等待会让整条测试静默耗到 60 秒预算、报一句没有信息的超时；有界并点名原因。
			const entered = await app.evaluate(({ BrowserWindow }, full) => {
				const win = BrowserWindow.getAllWindows()[0];
				if (!win) throw new Error("缺少桌面窗口");
				// 回调整体会被序列化到主进程执行：里面不能出现具名函数声明，tsx 的 keepNames 会插入
				// 主进程没有的 __name 助手。
				return new Promise<boolean>((resolve) => {
					const timer = setTimeout(() => resolve(false), 15000);
					// once 按事件名字面量重载，三元表达式会让重载解析失败；两条分支各自写全。
					if (full)
						win.once("enter-full-screen", () => {
							clearTimeout(timer);
							resolve(true);
						});
					else
						win.once("leave-full-screen", () => {
							clearTimeout(timer);
							resolve(true);
						});
					win.setFullScreen(full);
				});
			}, value);
			assert.ok(
				entered,
				`窗口未在 15 秒内${value ? "进入" : "退出"}全屏；请检查宿主锁屏和窗口状态，原生全屏验收尚未完成。`,
			);
			await page.locator(`html[data-window-controls='${value ? "none" : "left"}']`).waitFor();
		};
		await fullscreen(true);
		await drag(left, -22);
		await outline.waitFor();
		assert.equal(await left.getAttribute("aria-valuenow"), "200", "全屏下最窄左栏仍显示全部入口");
		assert.equal(await page.getByRole("button", { name: /^切换导航：/ }).count(), 0);
		await aligned("left");
		const buttons = await page.locator("[data-pane-header='left']").getByRole("button").all();
		assert.equal(buttons.length, 6, "五个入口及收起按钮都可操作");
		const handleBox = await left.boundingBox();
		assert.ok(handleBox);
		let previousRight = 0;
		for (const button of buttons) {
			const box = await button.boundingBox();
			assert.ok(box);
			assert.equal(box.width, 28, "紧凑布局保持 28px 点击宽度");
			assert.equal(box.height, 24, "紧凑布局保持 24px 点击高度");
			assert.ok(box.x >= previousRight + 2);
			assert.ok(box.x + box.width <= handleBox.x, "按钮与分栏拖动区不重叠");
			previousRight = box.x + box.width;
		}
		await page.getByRole("button", { name: "文件", exact: true }).click();
		await outline.click();
		await page.reload();
		await outline.waitFor();
		assert.equal(await left.getAttribute("aria-valuenow"), "200", "全屏重载仍使用真实窗口状态");
		await page.getByRole("button", { name: "收起左栏", exact: true }).click();
		const expand = page.getByRole("button", { name: "展开左栏", exact: true });
		assert.equal((await expand.boundingBox())?.x, 48, "收起后展开按钮也靠近导航轨");
		await expand.click();
		await fullscreen(false);
		await page.getByRole("button", { name: "切换导航：大纲", exact: true }).waitFor();
		await drag(left, 22);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
