import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare function requestAnimationFrame(callback: () => void): number;

test("对象搜索：精确标题优先，全部结果可达，返回与重载保留查询和已显示范围", { timeout: 45000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-object-search-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	await mkdir(join(root, "notes"));
	for (let i = 1; i <= 80; i += 1) {
		const name = `黄盖的准备${String(i).padStart(2, "0")}`;
		await writeFile(join(root, `notes/记录${String(i).padStart(2, "0")}.md`), "搜索目录延迟验收。\n");
		await writeFile(join(root, `intent/${name}.md`), `# ${name}\n\n仅用于搜索规模验收。\n`);
	}
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--workspace-callback-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(8000);
	const errors = collectPageErrors(page);
	const search = page.getByRole("textbox", { name: "搜索对象或文件", exact: true });
	const results = page.locator('[data-scroll-key="empty"] [data-page]');
	try {
		await page.locator('button[aria-label="新标签页"]').click();
		await search.fill("黄盖");
		assert.equal(await results.first().getAttribute("data-page"), "world/characters/黄盖.md");
		await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
		assert.equal(await search.isVisible(), true, "中文输入法确认候选时不打开结果");
		await search.press("Enter");
		await page.getByRole("heading", { name: "黄盖", exact: true }).waitFor();
		await page.getByRole("button", { name: "后退", exact: true }).click();
		await search.waitFor();
		assert.equal(await search.inputValue(), "黄盖");
		await search.fill("intent/");
		await page.getByText("已显示 60 / 81 个匹配", { exact: true }).waitFor();
		await page.getByRole("button", { name: "显示更多结果", exact: true }).click();
		await page.getByText("81 个匹配", { exact: true }).waitFor();
		assert.equal(await results.count(), 81);
		const last = page.locator('[data-scroll-key="empty"] [data-page="intent/黄盖的准备80.md"]');
		await last.scrollIntoViewIfNeeded();
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		await last.click();
		await page.getByRole("heading", { name: "黄盖的准备80", exact: true }).waitFor();
		await page.getByRole("button", { name: "后退", exact: true }).click();
		await last.waitFor();
		assert.equal(await search.inputValue(), "intent/");
		assert.equal(await results.count(), 81);
		await eventually(async () => {
			const item = await last.boundingBox();
			const area = await page.locator('[data-scroll-key="empty"]').boundingBox();
			return !!item && !!area && item.y >= area.y && item.y + item.height <= area.y + area.height;
		}, "返回后原结果仍在可视区域，不跳回列表顶部");
		await page.reload();
		await last.waitFor();
		assert.equal(await search.inputValue(), "intent/");
		assert.equal(await results.count(), 81);
		await search.fill("notes/");
		await page.getByText("已显示 60 / 80 个匹配", { exact: true }).waitFor();
		await page.getByRole("button", { name: "显示更多结果", exact: true }).click();
		const rawLast = page.locator('[data-scroll-key="empty"] [data-page="file:notes/记录80.md"]');
		await rawLast.scrollIntoViewIfNeeded();
		await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
		type Fixture = typeof globalThis & { workspaceTestCallbacks: { command: string; release?: () => void } };
		await app.evaluate(() => {
			(globalThis as Fixture).workspaceTestCallbacks.command = "workspace.files";
		});
		await page.reload();
		await eventually(
			() => app.evaluate(() => !!(globalThis as Fixture).workspaceTestCallbacks.release),
			"目录回复已拦住",
		);
		await page.getByText("正在读取文件…", { exact: true }).waitFor();
		await app.evaluate(() => (globalThis as Fixture).workspaceTestCallbacks.release?.());
		await rawLast.waitFor();
		await eventually(async () => {
			const item = await rawLast.boundingBox();
			const area = await page.locator('[data-scroll-key="empty"]').boundingBox();
			return !!item && !!area && item.y >= area.y && item.y + item.height <= area.y + area.height;
		}, "目录延迟加载后仍恢复到末尾结果");
		await search.fill("黄盖");
		assert.equal(
			await page.locator('[data-scroll-key="empty"]').evaluate((element) => element.scrollTop),
			0,
			"改查另一对象后回到结果顶部，输入框不被裁切",
		);
		await page.locator('button[aria-label="新标签页"]').click();
		await search.waitFor();
		assert.equal(await search.inputValue(), "", "新标签不继承另一标签的搜索");
		await search.fill("没有这个标题或路径");
		await page.getByText("没有匹配项。", { exact: true }).waitFor();
		await search.press("Enter");
		assert.equal(await search.inputValue(), "没有这个标题或路径");
		assert.equal(await results.count(), 0);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
