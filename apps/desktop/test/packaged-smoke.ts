/** 独立运行：npm run test:mac-package。必须提供本次与前次 .zip，不能退回开发入口冒充安装验收。 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot, SuimingHarness } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { call, fauxGateway, reply, say } from "../../../packages/runtime/test/harness-fixtures.js";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge };

test("macOS 安装包：首次启动、新建、替换安装、启动拒绝与整目录回退保全", { timeout: 180000 }, async () => {
	assert.equal(process.platform, "darwin");
	const currentZip = process.env.SUIMING_TEST_MAC_ZIP;
	const previousZip = process.env.SUIMING_TEST_PREVIOUS_MAC_ZIP;
	assert.ok(currentZip && previousZip, "指定隔离验收的新旧 macOS zip，不能使用开发 Electron 代替");
	const directory = await mkdtemp(join(tmpdir(), "suiming-installed-"));
	const applications = join(directory, "Applications");
	const installed = join(applications, "Suiming.app");
	const executablePath = join(installed, "Contents/MacOS/Suiming");
	const project = join(directory, "work");
	const report: Record<string, unknown> = { directory };
	// 输出和应用保留在独立临时目录，便于复查；不进入日常 Applications / 配置 / 凭据。
	async function install(zip: string) {
		await rm(installed, { recursive: true, force: true });
		await mkdir(applications, { recursive: true });
		execFileSync("ditto", ["-x", "-k", resolve(zip), applications]);
	}
	async function snapshot() {
		const service = await LocalProjectService.open(project);
		try {
			const history = await service.history();
			const entities = service.loadExecutionEntities();
			const objectRoot = join(project, ".suiming/objects");
			const objects: Record<string, string> = {};
			for (const file of await readdir(objectRoot, { recursive: true, withFileTypes: true }))
				if (file.isFile()) {
					const path = join(file.parentPath, file.name);
					objects[path.slice(objectRoot.length)] = createHash("sha256")
						.update(await readFile(path))
						.digest("hex");
				}
			return {
				objects,
				history,
				versions: await Promise.all(history.map((version) => service.exportRevision(version.id))),
				candidate: await service.checkoutCandidate(),
				entities,
				events: entities.sessions.map((session) => service.readSessionEvents(session.id)),
			};
		} finally {
			service.close();
		}
	}
	await install(previousZip);
	let app = await launchDesktop({ directory, executablePath });
	try {
		const page = await app.firstWindow();
		const errors = collectPageErrors(page);
		await page.getByRole("button", { name: "开始新作", exact: true }).waitFor();
		report.runtime = await app.evaluate(({ app }) => ({
			packaged: app.isPackaged,
			version: app.getVersion(),
			node: process.versions.node,
			electron: process.versions.electron,
		}));
		assert.equal((report.runtime as { packaged: boolean }).packaged, true);
		const packageFiles = await app.evaluate(({ app }) => {
			return process.getBuiltinModule("fs").readdirSync(app.getAppPath()).sort();
		});
		assert.deepEqual(packageFiles, ["LICENSE", "apps", "node_modules", "package.json"]);
		await page.screenshot({ path: join(directory, "first-launch.png") });
		const empty = join(directory, "first-work");
		await mkdir(empty);
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
		}, empty);
		await page.getByRole("button", { name: "开始新作", exact: true }).click();
		await page.getByRole("textbox", { name: "输入消息" }).waitFor();
		assert.equal((await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisions.length, 1);
		assert.deepEqual(errors, []);
		report.firstLaunchAndCreate = true;
	} finally {
		await app.close();
	}

	await mkdir(project);
	await materializeOpenStoryDirectorySnapshot(project, sampleWorkFiles());
	const service = await LocalProjectService.init({ checkoutPath: project });
	try {
		const result = await say(
			new SuimingHarness({
				project: service,
				models: fauxGateway(
					"install-fixture",
					[
						call("delegate", { profile: "main", goal: "写下长期选择" }),
						call("write", { path: "intent/选择.md", content: "保留人物的选择与代价。" }),
						call("submit_task", { summary: "已保存长期选择。" }),
						call("commit", { summary: "安装前第二版" }),
						reply("安装前的对话与任务结果必须保留。".repeat(6000)),
					],
					{ main: "main", reviewer: "main" },
				),
			}),
			"保留这段安装前对话。",
		);
		assert.equal(result.failure, undefined);
		await writeFile(join(project, "world/places/赤壁.md"), "第三版赤壁。\n");
		await service.commitCheckout();
		await writeFile(join(project, "intent/候选.md"), "尚未提交的选择。\n");
	} finally {
		service.close();
	}
	const expected = await snapshot();
	assert.equal(expected.history.length, 3);
	assert.equal(expected.entities.tasks.length, 1);
	assert.ok(Object.keys(expected.objects).length > 0, "长回复必须覆盖 SQLite 之外的执行对象文件");
	async function openAndCheck(label: string, explicit = false) {
		app = await launchDesktop({ directory, executablePath, ...(explicit ? { project } : {}) });
		try {
			const page = await app.firstWindow();
			const errors = collectPageErrors(page);
			await page.getByRole("textbox", { name: "输入消息" }).waitFor();
			const shown = await page.evaluate(() => window.suiming.invoke("workspace.show", {}));
			assert.equal(shown.revisions.length, 3);
			assert.equal(shown.dirty, true);
			await page.getByRole("button", { name: "选择对话", exact: true }).click();
			await page.getByRole("dialog").getByRole("button").first().click();
			await page.locator(".message.assistant").filter({ hasText: "安装前的对话与任务结果必须保留" }).waitFor();
			await page.reload();
			await page.locator(".message.assistant").filter({ hasText: "安装前的对话与任务结果必须保留" }).waitFor();
			await page.screenshot({ path: join(directory, `${label}.png`) });
			assert.deepEqual(errors, []);
		} finally {
			await app.close();
		}
		assert.deepEqual(await snapshot(), expected, "安装和重载不丢版本、候选、任务、消息，不增加调用");
		report[label] = true;
	}
	await openAndCheck("before-upgrade", true);
	// 冷备份包括整个作品和本次隔离的界面状态；不能只备份可见文件或导出的作品快照。
	await cp(project, join(directory, "backup"), { recursive: true });
	await cp(join(directory, "app-data"), join(directory, "app-data-backup"), { recursive: true });
	await install(currentZip);
	await openAndCheck("after-upgrade");

	// 不兼容的执行库只在故障副本上构造，当前版本必须拒绝且把原因展示出来。
	const dbPath = join(project, ".suiming/local.sqlite");
	const db = new DatabaseSync(dbPath);
	db.exec("UPDATE schema_meta SET version = 999");
	db.close();
	const rejectedBytes = await readFile(dbPath);
	app = await launchDesktop({ directory, executablePath });
	try {
		const page = await app.firstWindow();
		await page.getByRole("alert").filter({ hasText: "不能自动升级" }).waitFor();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 640));
		await page.screenshot({ path: join(directory, "rejected-upgrade.png") });
		assert.deepEqual(await readFile(dbPath), rejectedBytes);
	} finally {
		await app.close();
	}
	report.incompatibleRejectedWithoutRewrite = true;
	await rm(project, { recursive: true });
	await cp(join(directory, "backup"), project, { recursive: true });
	await rm(join(directory, "app-data"), { recursive: true });
	await cp(join(directory, "app-data-backup"), join(directory, "app-data"), { recursive: true });
	await install(previousZip);
	await openAndCheck("after-rollback");
	assert.equal((await readdir(directory)).includes("auth.json"), false, "不调用登录，不产生或读取日常凭据");
	report.revisions = expected.history.length;
	report.sessions = expected.entities.sessions.length;
	report.tasks = expected.entities.tasks.length;
	report.executionObjects = Object.keys(expected.objects).length;
	await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
});
