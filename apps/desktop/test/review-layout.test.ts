import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composeReviewFile, LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { Locator } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { assertNoTooltip, collectPageErrors, launchDesktop } from "./launch.js";

declare const innerWidth: number;
declare function requestAnimationFrame(callback: () => void): number;

test("审稿长意见：单条不重复目录，多条可预览和切换，窄窗保留正文空间", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-review-layout-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root });
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "军杖落下，黄盖咬住了衣角。\n\n他没有喊。\n");
	await project.commitCheckout();
	const revision = await project.refreshHead();
	const candidate = await project.historyReader().snapshot(revision);
	const longTitle =
		"代词指向需要结合前后行动核对：读者先看到阚泽取印，随后才从伤口渗血确认伸手的人是黄盖，应明确动作归属，保留亲身承担代价的场面。".repeat(
			2,
		);
	await mkdir(join(root, "review"), { recursive: true });
	for (const count of [0, 1, 12]) {
		const review = composeReviewFile(candidate, {
			layer: "text",
			scope: { kind: "beats", storyBeatIds: ["beat-0001"] },
			revision,
			draft: {
				verdict: count ? "revise" : "pass",
				summary: "核对人物行动与身体代价。",
				findings: Array.from({ length: count }, (_, index) => ({
					severity: "minor",
					anchor: { kind: "artifact", path: "text/beat-0001.md" },
					issue: index === 1 ? "身体动作" : `${index + 1}. ${longTitle}`,
					evidence: "“他没有喊”仍可结合身体动作判断人物的选择。".repeat(6),
					repairLayer: "text",
					suggestion: "保留克制表达，明确动作的承担者。",
				})),
				uncovered: [],
				uncertainties: [],
			},
		});
		await writeFile(join(root, `review/layout-${count}.md`), review.content);
	}
	await project.commitCheckout();
	project.close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(7000);
	const errors = collectPageErrors(page);
	const button = (name: string) => page.getByRole("button", { name, exact: true });
	const openReport = async (count: number) => {
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "搜索", exact: true }).click();
		await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill(`review/layout-${count}.md`);
		await page.locator(`.item-btn[data-page="review/layout-${count}.md"]`).click();
		await page.getByRole("heading", { name: `审稿报告 · ${count} 条问题` }).waitFor();
	};
	const size = async (width: number, height: number) => {
		await app.evaluate(
			({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows()[0]?.setSize(width, height),
			{ width, height },
		);
		await page.waitForFunction((width) => innerWidth === width, width);
		// 先等 ResizeObserver 和窄栏入口落地，再判断是否需要展开右栏。
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		if (width === 960) {
			const expand = button("展开右栏");
			if (await expand.isVisible()) await expand.click();
		}
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
	};
	const box = async (locator: Locator) => {
		const rect = await locator.boundingBox();
		assert.ok(rect);
		return rect;
	};
	const capture = async (name: string) => {
		if (!process.env.SUIMING_UI_CAPTURE) return;
		await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
		await page.screenshot({ path: join(process.env.SUIMING_UI_CAPTURE, `${name}.png`) });
	};
	try {
		await openReport(1);
		assert.equal(await page.getByRole("region", { name: "审稿结论与问题" }).count(), 0, "单条意见不保留重复目录");
		await page
			.locator("h2")
			.filter({ hasText: `1. ${longTitle}` })
			.waitFor();
		await capture("single-wide");
		await size(960, 640);
		await page.locator(".issue-current").waitFor();
		assert.ok((await box(page.locator(".issue-current"))).height > 150);
		await capture("single-narrow");
		await size(1460, 940);
		await openReport(12);
		const list = page.getByRole("region", { name: "审稿结论与问题" });
		const first = list.getByRole("button", { name: `1. 1. ${longTitle}`, exact: true });
		await first.waitFor();
		assert.ok((await box(first)).height <= 64, "目录长意见最多两行，不挤掉其他意见");
		await first.hover();
		const tooltip = page.getByRole("tooltip");
		await tooltip.filter({ hasText: longTitle }).waitFor();
		const tip = await box(tooltip);
		assert.ok(tip.x >= 0 && tip.y >= 0 && tip.x + tip.width <= 1460 && tip.y + tip.height <= 940);
		await capture("many-preview");
		await list.getByRole("button", { name: "2. 身体动作", exact: true }).hover();
		await assertNoTooltip(page);
		await list.getByRole("button", { name: `12. 12. ${longTitle}`, exact: true }).click();
		await page
			.locator("h2")
			.filter({ hasText: `12. ${longTitle}` })
			.waitFor();
		await size(960, 640);
		const chooser = page.getByRole("combobox", { name: "选择审稿意见", exact: true });
		await chooser.waitFor();
		assert.ok((await box(chooser)).height <= 40, "窄窗选择器不重复展开长意见");
		assert.ok((await box(page.locator(".issue-current"))).height > 100);
		const chooserBox = await box(chooser);
		const manuscriptBox = await box(page.locator(".issue-current"));
		assert.ok(chooserBox.x + chooserBox.width <= manuscriptBox.x + manuscriptBox.width);
		await chooser.click();
		const selectedOption = page.getByRole("option", { name: `12. 12. ${longTitle}`, exact: true });
		await selectedOption.hover();
		const menuBox = await box(page.locator("[data-slot=select-content]"));
		assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 960);
		assert.ok((await box(selectedOption)).height <= 60);

		await tooltip.filter({ hasText: longTitle }).waitFor();
		await capture("narrow-menu-preview");
		await page.getByRole("option", { name: "2. 身体动作", exact: true }).click();
		await page.locator("h2").filter({ hasText: "身体动作" }).waitFor();
		await page.reload();
		await chooser.filter({ hasText: "身体动作" }).waitFor();
		await button("复核这条意见").waitFor();
		await capture("many-narrow");
		await size(1460, 940);
		await openReport(0);
		await size(960, 640);
		assert.equal(await list.count(), 0);
		await page.getByText("没有意见：审稿人判断被审内容成立。", { exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
