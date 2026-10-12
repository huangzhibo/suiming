import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService } from "@suiming/runtime";
import type { Locator } from "playwright";
import { collectPageErrors, launchDesktop } from "./launch.js";

test("提示定位：四向布局、边缘避让与分布标记的动态锚点", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-tooltip-placement-"));
	const root = join(directory, "work");
	await cp(resolve("examples/sanguo"), root, { recursive: true });
	const longFile = `zz-99-${"long-reference-name-".repeat(11)}.md`;
	for (let index = 0; index < 35; index++)
		await writeFile(join(root, `zz-${String(index).padStart(2, "0")}.md`), "边界定位测试材料");
	await writeFile(join(root, longFile), "长路径边界测试材料");
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors = collectPageErrors(page);
	const tip = page.getByRole("tooltip");
	const button = (name: string) => page.getByRole("button", { name, exact: true });
	const settle = () =>
		page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
	const capture = async (name: string) => {
		const output = process.env.SUIMING_TOOLTIP_SCREENSHOTS;
		if (!output) return;
		await mkdir(output, { recursive: true });
		await page.screenshot({ path: join(output, `${name}.png`) });
	};
	const placement = async (target: Locator, side: string, selectedX?: number) => {
		await target.and(page.locator("[data-popup-open]")).waitFor();
		await tip.waitFor();
		await tip.evaluate((element) =>
			Promise.all(element.getAnimations().map((animation: { finished: Promise<unknown> }) => animation.finished)),
		);
		await settle();
		assert.equal(await tip.getAttribute("data-side"), side);
		const box = await tip.boundingBox();
		const anchor = await target.boundingBox();
		const arrow = await tip.locator('[data-slot="tooltip-arrow"]').boundingBox();
		const viewport = (await page.evaluate("({width: innerWidth, height: innerHeight})")) as {
			width: number;
			height: number;
		};
		assert.ok(box && anchor && arrow);
		assert.ok(
			box.x >= 7 &&
				box.y >= 7 &&
				box.x + box.width <= viewport.width - 7 &&
				box.y + box.height <= viewport.height - 7,
			JSON.stringify({ box, viewport }),
		);
		const vertical = side === "top" || side === "bottom";
		const expected = vertical ? (selectedX ?? anchor.x + anchor.width / 2) : anchor.y + anchor.height / 2;
		const actual = vertical ? arrow.x + arrow.width / 2 : arrow.y + arrow.height / 2;
		assert.ok(
			Math.abs(actual - expected) < 3,
			`箭头应指向触发位置：${JSON.stringify({ side, expected, actual, box, anchor })}`,
		);
		assert.ok(
			side === "top"
				? box.y + box.height <= anchor.y
				: side === "bottom"
					? box.y >= anchor.y + anchor.height
					: side === "left"
						? box.x + box.width <= anchor.x
						: box.x >= anchor.x + anchor.width,
			"提示不能覆盖触发对象",
		);
	};
	const hover = async (target: Locator, side: string, name: string) => {
		await page.mouse.move(2, 2);
		await page.keyboard.press("Escape");
		await tip.waitFor({ state: "hidden" });
		await target.hover();
		await placement(target, side);
		await capture(name);
	};
	try {
		await button("大纲").waitFor();
		await app.evaluate(({ BrowserWindow, app }) => {
			app.focus({ steal: true });
			BrowserWindow.getAllWindows()[0]?.focus();
		});
		await hover(button("大纲"), "bottom", "toolbar-bottom");
		await hover(button("打开故事轴"), "right", "actions-right");
		await hover(button("设置"), "right", "bottom-edge-right");
		await page.getByRole("textbox", { name: "输入消息", exact: true }).fill("检查提示位置，不发送");
		await hover(button("发送"), "top", "composer-top");
		await button("搜索").click();
		await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill("world/characters/刘备.md");
		await page.locator('.item-btn[data-page="world/characters/刘备.md"]').click();
		await button("收起右栏").click();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1460, 940));
		await page.waitForFunction("innerWidth === 1460");
		await settle();
		const track = page.locator("[data-character-track]");
		const rail = track.getByRole("navigation", { name: "按卷定位人物经历" });
		await hover(rail.getByRole("button").first(), "left", "character-rail-left");
		const distribution = track.getByRole("slider", { name: "全书分布" });
		await page.keyboard.press("Escape");
		await distribution.scrollIntoViewIfNeeded();
		await page.keyboard.press("Shift");
		await button("人物经历说明").focus();
		await distribution.focus();
		for (const key of ["Home", "End"]) {
			await distribution.press(key);
			await settle();
			const plot = await distribution.locator("[data-character-plot]").boundingBox();
			assert.ok(plot);
			const ordinal = Number(await distribution.getAttribute("aria-valuenow"));
			await placement(distribution, "top", plot.x + (plot.width * (ordinal - 0.5)) / 231);
			await capture(`distribution-${key.toLowerCase()}`);
		}
		const plot = await distribution.locator("[data-character-plot]").boundingBox();
		assert.ok(plot);
		const x = plot.x + (plot.width * 172.5) / 231;
		await page.mouse.move(x, plot.y + plot.height / 2, { steps: 8 });
		await tip.filter({ hasText: "秘密揭示：蔡氏谋害刘备" }).waitFor();
		await placement(distribution, "top", x);
		await capture("distribution-secret");
		await page.keyboard.press("Escape");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction("innerWidth === 960");
		await settle();
		await distribution.scrollIntoViewIfNeeded();
		await page.keyboard.press("Shift");
		await button("人物经历说明").focus();
		await distribution.focus();
		await distribution.press("End");
		await settle();
		const narrowPlot = await distribution.locator("[data-character-plot]").boundingBox();
		assert.ok(narrowPlot);
		await placement(distribution, "top", narrowPlot.x + (narrowPlot.width * 230.5) / 231);
		await capture("narrow-distribution-end");
		await page.keyboard.press("Escape");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1460, 940));
		await page.waitForFunction("innerWidth === 1460");
		await settle();
		await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill("outline/story/vol-0001/beat-0005.md");
		await page.locator('.item-btn[data-page="outline/story/vol-0001/beat-0005.md"]').click();
		const node = page.locator('[data-neighborhood] [role="button"]').first();
		await hover(node, "left", "graph-node-left");
		await hover(page.locator('[data-neighborhood] [role="button"]').last(), "right", "graph-node-right");
		await page.keyboard.press("Escape");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction("innerWidth === 960");
		await settle();
		await hover(page.locator('[data-neighborhood] [role="button"]').last(), "left", "graph-edge-flip");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1460, 940));
		await page.waitForFunction("innerWidth === 1460");
		await settle();
		await button("打开故事轴").click();
		await hover(page.locator("[data-volume]").first(), "bottom", "story-axis-volume");
		await button("大纲").click();
		await hover(page.locator(".beat-row").first(), "right", "outline-right");
		await button("文件").click();
		const file = page.locator(`[data-file-path="${longFile}"]`);
		await file.evaluate((element) => element.scrollIntoView({ block: "end" }));
		await hover(file, "right", "long-path-bottom-edge");
		const fileBox = await file.boundingBox();
		const tipBox = await tip.boundingBox();
		assert.ok(
			fileBox && tipBox && Math.abs(tipBox.y + tipBox.height / 2 - fileBox.y - fileBox.height / 2) > 5,
			"长路径应确实触发纵向避让，不能只检查居中的常态",
		);
		await page.keyboard.press("Escape");
		await tip.waitFor({ state: "hidden" });
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
