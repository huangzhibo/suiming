import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles, sampleWorkText } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

declare const innerWidth: number;
declare function requestAnimationFrame(callback: () => void): number;

test("对象页按用途展示：期待阶段、资源流转、地点情节和情节依赖在窄窗仍可读可跳转", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-object-pages-"));
	const root = join(directory, "work");
	await cp(resolve("examples/sanguo"), root, { recursive: true });
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	try {
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "搜索", exact: true }).click();
		const search = page.getByRole("textbox", { name: "搜索作品", exact: true });
		const visit = async (path: string) => {
			await search.fill(path);
			await page.locator(`.item-btn[data-page="${path}"]`).click();
		};
		await visit("outline/contracts/七星刀刺董.md");
		const contract = page.locator("[data-contract-track]");
		await contract.getByText("已回应", { exact: true }).waitFor();
		assert.equal(await page.getByRole("heading", { name: "七星刀行刺", exact: true }).count(), 1);
		assert.equal(await contract.locator('[data-phase="open"] [data-page]').count(), 1);
		assert.equal(await contract.locator('[data-phase="resolve"] [data-page]').count(), 1);
		await contract
			.getByRole("button", { name: /献刀脱身与陈宫释曹/ })
			.first()
			.press("Space");
		await page.getByRole("radio", { name: "设计", exact: true }).click();
		const graph = page.locator("[data-neighborhood]");
		await graph.getByText("曹操", { exact: true }).waitFor();
		assert.ok((await graph.locator("path").count()) > 0, "情节页保留关联节点与连线，不能退化成文本列");

		await visit("outline/contracts/关羽归刘.md");
		assert.equal(await contract.locator('[data-phase="advance"] [data-page]').count(), 4);
		await visit("world/resources/传国玉玺.md");
		const resource = page.locator("[data-resource-flow]");
		assert.equal(await resource.locator("[data-resource-event]").count(), 3);
		await resource.getByText("由孙坚持有", { exact: true }).waitFor();
		await resource.getByText("由曹操持有", { exact: true }).waitFor();
		await resource.locator('[data-page$="beat-0034.md"]').click();
		await page.getByRole("radio", { name: "设计", exact: true }).waitFor();
		await visit("world/places/洛阳.md");
		const usage = page.locator("[data-place-usage]");
		await graph.getByRole("button", { name: /还有 2 项/ }).click();
		assert.equal(await graph.locator("[data-page]").count(), 10, "展开后节点与连线均保留");
		assert.equal(await usage.locator("[data-place-volume]").count(), 4);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.waitForFunction(() => innerWidth === 960);
		await page.evaluate(
			() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
		);
		assert.equal(await usage.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
		const links = await graph.locator("[data-page]").all();
		for (let i = 1; i < links.length; i++) {
			const a = await links[i - 1]?.boundingBox();
			const b = await links[i]?.boundingBox();
			assert.ok(a && b && b.y >= a.y + a.height - 1, "情节标题换行后不能相互覆盖");
		}
		await links[0]?.press("Space");
		await page.getByRole("radio", { name: "设计", exact: true }).waitFor();
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("稀疏对象：资源开场归属与消耗有依据，空地点和空资源不画伪造轨迹", { timeout: 30000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-sparse-objects-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	await writeFile(join(root, "world/places/空地点.md"), "尚未在情节中使用的地点。\n");
	await writeFile(join(root, "world/resources/空资源.md"), "尚未记录归属的资源。\n");
	// 两个大分组用于核对「更多」不会总是展开第一组；新增文件只作为布局 fixture。
	const people = Array.from({ length: 9 }, (_, i) => `验收人物${i + 1}`);
	const resources = Array.from({ length: 9 }, (_, i) => `验收资源${i + 1}`);
	for (const name of people) await writeFile(join(root, `world/characters/${name}.md`), "布局验收人物。\n");
	for (const name of resources) await writeFile(join(root, `world/resources/${name}.md`), "布局验收资源。\n");
	const beatPath = "outline/story/vol-0001/beat-0001.md";
	await writeFile(
		join(root, beatPath),
		sampleWorkText(beatPath)
			.replace("character: [黄盖]", `character: [黄盖, ${people.join(", ")}]`)
			.replace("resource: [火船]", `resource: [火船, ${resources.join(", ")}]`),
	);

	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	try {
		await page.locator("[data-navigation-icons]").getByRole("button", { name: "搜索", exact: true }).click();
		const search = page.getByRole("textbox", { name: "搜索作品", exact: true });
		const visit = async (path: string) => {
			await search.fill(path);
			await page.locator(`.item-btn[data-page="${path}"]`).click();
		};
		await visit("outline/story/vol-0001/beat-0001.md");
		await page.getByRole("radio", { name: "设计", exact: true }).click();
		const graph = page.getByRole("group", { name: "邻域图", exact: true });
		const more = graph.getByRole("button", { name: "还有 2 项，展开", exact: true });
		assert.equal(await more.count(), 2);
		await more.last().click();
		assert.equal(await graph.locator('[data-page^="world/resources/"]').count(), 10);
		assert.equal(await graph.locator('[data-page^="world/characters/"]').count(), 8, "展开资源不应误开人物组");
		await visit("world/resources/火船.md");
		const flow = page.locator("[data-resource-flow]");
		await flow.getByText("开场归属：由黄盖持有", { exact: true }).waitFor();
		await flow.getByText("已消耗", { exact: true }).waitFor();
		await flow.locator("[data-page]").press("Enter");
		await page.getByRole("heading", { name: "beat-0002", exact: true }).waitFor();
		await visit("world/resources/空资源.md");
		await flow.getByText("尚无归属、位置、消耗或毁坏的变化记录。", { exact: true }).waitFor();
		assert.equal(await flow.locator("[data-resource-event]").count(), 0);
		await visit("world/places/空地点.md");
		await page.getByText("尚无情节关联这个地点。", { exact: true }).waitFor();
		assert.equal(await page.locator("[data-place-volume]").count(), 0);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
