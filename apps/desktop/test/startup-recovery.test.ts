import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

for (const entry of ["recent", "explicit"] as const) {
	test(`启动时${entry === "recent" ? "重开最近" : "指定"}作品不兼容：显示保全原因，还能打开其他作品`, {
		timeout: 30000,
	}, async () => {
		const directory = await mkdtemp(join(tmpdir(), "suiming-startup-"));
		const project = join(directory, "incompatible");
		const healthy = join(directory, "healthy");
		for (const path of [project, healthy]) {
			await mkdir(path);
			await materializeOpenStoryDirectorySnapshot(path, sampleWorkFiles());
			(await LocalProjectService.init({ checkoutPath: path })).close();
		}
		const dbPath = join(project, ".suiming/local.sqlite");
		const db = new DatabaseSync(dbPath);
		db.exec("UPDATE schema_meta SET version = 999");
		db.close();
		const before = await readFile(dbPath);
		await mkdir(join(directory, "app-data"));
		await writeFile(join(directory, "app-data/workspace.json"), JSON.stringify({ path: project, recent: [project] }));
		const app = await launchDesktop({ directory, ...(entry === "explicit" ? { project } : {}) });
		try {
			const page = await app.firstWindow();
			const errors = collectPageErrors(page);
			await page.getByRole("alert").filter({ hasText: "不能自动升级" }).waitFor({ timeout: 6000 });
			assert.match(await page.getByRole("alert").innerText(), /完整备份作品目录/);
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
			const alert = await page.getByRole("alert").boundingBox();
			const open = await page.getByRole("button", { name: "打开作品 ↗" }).boundingBox();
			const height = await page.evaluate(() => (globalThis as unknown as { innerHeight: number }).innerHeight);
			assert.ok(
				alert && open && alert.y + alert.height < open.y && open.y + open.height <= height,
				"最小窗口先显示失败原因，再给打开入口，不能裁掉恢复操作",
			);
			assert.deepEqual(await readFile(dbPath), before, "拒绝旧格式不能重建或改写执行库");
			await app.evaluate(({ dialog }, path) => {
				dialog.showOpenDialog = (async () => ({
					canceled: false,
					filePaths: [path],
				})) as typeof dialog.showOpenDialog;
			}, healthy);
			await page.getByRole("button", { name: "打开作品 ↗" }).click();
			await page.getByRole("textbox", { name: "输入消息" }).waitFor();
			assert.deepEqual(errors, []);
		} finally {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
