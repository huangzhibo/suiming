import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService } from "@suiming/runtime";
import { collectPageErrors, launchDesktop } from "./launch.js";

declare const innerWidth: number;
declare function requestAnimationFrame(callback: () => void): number;

test("逐页去重：地点分布联动关系图、资源同节归组、检查提示保留一次且仍可搜索", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-page-polish-"));
	const root = join(directory, "work");
	await cp(resolve("examples/sanguo"), root, { recursive: true });
	(await LocalProjectService.init({ checkoutPath: root })).close();
	// 同节多变化的临时候选；不修改公共作品。
	const path = join(root, "outline/story/vol-0001/beat-0018.md");
	const original = await readFile(path, "utf8");
	await writeFile(path, original.replace("赤兔马.holder: 吕布", "赤兔马.holder: none\n    赤兔马.location: 洛阳"));
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	const capture = async (name: string) => {
		if (!process.env.SUIMING_UI_CAPTURE) return;
		await mkdir(process.env.SUIMING_UI_CAPTURE, { recursive: true });
		await page.screenshot({ path: join(process.env.SUIMING_UI_CAPTURE, name), type: "jpeg", quality: 85 });
	};
	try {
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "搜索", exact: true }).click();
		const chat = page.getByRole("button", { name: "收起右栏", exact: true });
		if (await chat.isVisible()) await chat.click();
		const visit = async (path: string) => {
			await page.getByRole("textbox", { name: "搜索作品", exact: true }).fill(path);
			await page.locator(`.item-btn[data-page="${path}"]`).click();
		};
		await visit("world/resources/赤兔马.md");
		const flow = page.locator("[data-resource-flow]");
		assert.equal(await flow.locator("[data-resource-event]").count(), 3);
		assert.equal(await flow.locator("[data-resource-event]").first().locator("[data-resource-change]").count(), 2);
		await page.getByText("赤兔马：由董卓持有", { exact: true }).waitFor();
		assert.equal(await page.getByText(/开场归属：/).count(), 0);
		assert.equal(await page.locator("article summary").count(), 0);
		await capture("05-resource-after.jpg");
		await flow.locator("[data-resource-event]").first().locator("[data-page]").press("Enter");
		await page.getByRole("heading", { name: "赤兔诱吕布杀丁原", exact: true }).waitFor();
		await visit("world/places/荆州.md");
		const usage = page.locator("[data-place-usage]");
		const graph = page.locator("[data-neighborhood]");
		await usage.getByRole("button", { name: "新野求贤与江东进取 5 个", exact: true }).press("Space");
		assert.equal(await graph.locator('[data-page^="outline/story/"]').count(), 5);
		assert.ok((await graph.locator("path").count()) >= 5, "筛选保留连线");
		await capture("06-place-filtered.jpg");
		await graph.locator('[data-page^="outline/story/"]').first().press("Enter");
		await page.getByRole("heading", { name: "江夏得的卢移屯新野", exact: true }).waitFor();
		await visit("world/places/荆州.md");
		await usage.getByRole("button", { name: "全书", exact: true }).click();
		await graph.getByRole("button", { name: "还有 3 项，展开", exact: true }).click();
		assert.equal(await graph.locator('[data-page^="outline/story/"]').count(), 11);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => innerWidth === 960);
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		assert.equal(await usage.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
		await usage.getByRole("button", { name: "赤壁火攻与华容放曹 2 个", exact: true }).click();
		assert.equal(await graph.locator('[data-page^="outline/story/"]').count(), 2);
		await capture("07-place-narrow.jpg");
		await page.getByRole("button", { name: "检查", exact: true }).click();
		await page.getByRole("button", { name: "查看详情", exact: true }).click();
		const filter = page.getByRole("textbox", { name: "筛选诊断", exact: true });
		await filter.fill("beat-0014");
		const group = page.locator('[data-check-path="outline/story/vol-0001/beat-0014.md"]');
		assert.equal(await group.locator("li").count(), 7);
		assert.equal(await group.locator("[data-check-shared-hint]").count(), 1);
		assert.equal(await group.locator("li").filter({ hasText: "只是顺带一提可以不管" }).count(), 0);
		await filter.fill("只是顺带一提可以不管");
		assert.ok((await group.locator("li").count()) > 0, "合并后的提示仍可作为搜索条件");
		await capture("08-check-after.jpg");
		await filter.fill("不存在的筛选词");
		await page.getByText("没有符合筛选条件的诊断。", { exact: true }).waitFor();
		await page.getByRole("button", { name: "清除筛选", exact: true }).click();
		assert.equal(await page.getByText(/^显示 \d+ \/ \d+ 条$/).count(), 0);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
