import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { assertNoTooltip, collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const innerWidth: number;
declare function requestAnimationFrame(callback: () => void): number;

test("候选差异提交后保留文件并转到新版本，迟到回包不抢走正在阅读的页面", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-commit-navigation-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const append = async (path: string, text: string) =>
		writeFile(join(root, path), `${await readFile(join(root, path), "utf8")}\n${text}\n`);
	await append("world/core.md", "提交前核对世界。 ");
	await append("intent/计谋的代价.md", "提交前核对意图。");
	const app = await launchDesktop({ directory, project: root, flags: ["--workspace-callback-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors = collectPageErrors(page);
	const button = (name: string) => page.getByRole("button", { name, exact: true });
	try {
		await button("2 个文件未提交").click();
		await button("选择变更文件").click();
		await page.getByRole("option", { name: /world\/core.md/ }).click();
		await page.locator(".cm-content").filter({ hasText: "提交前核对世界" }).waitFor();
		await button("提交版本").click();
		await button("选择作品版本").filter({ hasText: /^r2/ }).waitFor();
		assert.match(await button("选择变更文件").innerText(), /world\/core.md/);
		await page.reload();
		await button("选择作品版本").filter({ hasText: /^r2/ }).waitFor();
		assert.match(await button("选择变更文件").innerText(), /world\/core.md/);

		await append("world/core.md", "第二次提交。");
		await button("1 个文件未提交").click();
		type Fixture = typeof globalThis & { workspaceTestCallbacks: { command: string; release?: () => void } };
		await app.evaluate(() => {
			(globalThis as Fixture).workspaceTestCallbacks.command = "project.commit";
		});
		await button("提交版本").click();
		await eventually(
			() => app.evaluate(() => !!(globalThis as Fixture).workspaceTestCallbacks.release),
			"等待提交回包进入测试闸门",
		);
		await button("新标签页").click();
		const search = page.getByRole("textbox", { name: "搜索对象或文件", exact: true });
		await search.waitFor();
		await app.evaluate(() => (globalThis as Fixture).workspaceTestCallbacks.release?.());
		await page.getByText("已提交一个新版本", { exact: true }).waitFor();
		assert.equal(await search.isVisible(), true);
		assert.equal(await button("选择作品版本").count(), 0, "提交回包不跳离作者后来打开的页面");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("导航空间：版本逐文件核对、跨版本定位、最近访问截断提示与依据去重", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-navigation-space-"));
	const root = join(directory, "work");
	const longName = "贯穿全书的人物选择与承诺代价在不同章节中的表达和验收依据".repeat(2);
	const added = `intent/${longName}.md`;
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root });
	await writeFile(join(root, added), `# ${longName}\n\n新增创作意图。\n`);
	await writeFile(
		join(root, "world/core.md"),
		`${await readFile(join(root, "world/core.md"), "utf8")}\n版本导航标记。\n`,
	);
	await project.commitCheckout();
	project.close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors = collectPageErrors(page);
	const tooltipBox = async () => {
		const tooltip = page.getByRole("tooltip");
		// 可见时仍可能处于进入动画，位置断言应测量动画结束后的布局。
		await tooltip.evaluate((el) =>
			Promise.all(
				el.getAnimations().map((animation: { finished: Promise<unknown> }) => animation.finished.catch(() => {})),
			),
		);
		return tooltip.boundingBox();
	};
	const button = (name: string) => page.getByRole("button", { name, exact: true });
	const capture = async (name: string) => {
		if (process.env.SUIMING_UI_CAPTURE) {
			await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
			await page.screenshot({
				path: join(process.env.SUIMING_UI_CAPTURE, name),
				type: "jpeg",
				quality: 85,
				animations: "disabled",
			});
		}
	};
	try {
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "材料", exact: true }).click();
		const materialLink = page.locator(`.item-btn[data-page="${added}"]`);
		await page.keyboard.press("Shift");
		await materialLink.focus();
		await page.getByRole("tooltip").filter({ hasText: longName }).waitFor();
		const materialTip = await tooltipBox();
		const materialBox = await materialLink.boundingBox();
		assert.ok(materialTip && materialBox && materialTip.x >= materialBox.x + materialBox.width);
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: /^r2 ·/ }).click();
		await page.locator(".cm-host").waitFor();
		await button("选择变更文件").click();
		await page.getByRole("combobox", { name: "搜索变更文件", exact: true }).fill(added);
		await page.getByRole("option", { name: new RegExp(longName) }).click();
		assert.equal(await button("上一个变更文件").getAttribute("aria-disabled"), "true");
		await button("下一个变更文件").hover();
		const tooltip = page.getByRole("tooltip");
		await tooltip.filter({ hasText: "world/core.md" }).waitFor();
		const tipBox = await tooltipBox();
		const triggerBox = await button("下一个变更文件").boundingBox();
		assert.ok(tipBox && triggerBox && tipBox.y >= triggerBox.y + triggerBox.height && tipBox.x >= 0);
		await button("下一个变更文件").click();
		await page.locator(".cm-content").filter({ hasText: "版本导航标记。" }).waitFor();
		assert.equal(await button("下一个变更文件").getAttribute("aria-disabled"), "true");
		await button("上一个变更文件").press("Enter");
		await button("选择作品版本").click();
		await page.getByRole("menuitemradio", { name: /^r1 ·/ }).click();
		await page.getByRole("heading", { name: "当前文件在这个版本没有变更", exact: true }).waitFor();
		await button("查看本版本的变更").click();
		await page.locator(".cm-host").waitFor();
		assert.ok(!(await button("选择变更文件").innerText()).includes(longName));
		await capture("04-version-after.jpg");
		// 新标签页按对象类型辨识，长标题和路径仅在截断时补全。
		await button("新标签页").click();
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(` ${longName} `);
		const row = page.locator('[data-scroll-key="empty"] [data-page]').first();
		await row.waitFor();
		assert.match(await row.innerText(), /创作意图/);
		await page.keyboard.press("Tab");
		await row.focus();
		await tooltip.filter({ hasText: added }).waitFor();
		await capture("05-recent-tooltip.jpg");
		await page.keyboard.press("Escape");
		await row.press("Enter");
		await page.getByRole("heading", { name: longName, exact: true }).waitFor();
		if (await button("展开右栏").isVisible()) await button("展开右栏").click();
		await button("依据").click();
		assert.equal(await page.getByText(/· 第 1 段$/).count(), 0);
		await button("新标签页").click();
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("world/core.md");
		await row.hover();
		await assertNoTooltip(page, "完整标题与路径不重复提示");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => innerWidth === 960);
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill(longName);
		await row.hover();
		await tooltip.filter({ hasText: added }).waitFor();
		const narrow = await tooltipBox();
		assert.ok(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 960);
		const intentLink = page.locator(`#workbench-right [data-page="${added}"]`);
		const rightLink = await intentLink.boundingBox();
		assert.ok(rightLink && rightLink.x + rightLink.width <= 960, "依据中的长意图名称不溢出窗口");
		assert.equal(await intentLink.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
		await capture("06-recent-narrow.jpg");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
