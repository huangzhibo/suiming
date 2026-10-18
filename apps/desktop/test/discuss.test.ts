import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming: DesktopBridge };

// ADR-0039：讨论用 `/讨论` 打开，开着时输入框底部有「讨论中」标记，点一下关上；关着时标记不占位置。
// 开着时 Agent 硬要写也写不进去、不替作者存草稿；关上后能改也能提交。
// faux 模型的越界动作在 entry.ts 的 --discuss-test。
test("讨论：/讨论 打开后只读不碰草稿，点标记关上后照方案改并提交", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-discuss-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--discuss-test"] });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(10000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		const toggle = page.getByRole("button", { name: "讨论", exact: true });
		const pressed = (value: boolean) => page.locator(`button[aria-label="讨论"][aria-pressed="${value}"]`).waitFor();
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		const disk = () => readFile(join(root, "world/core.md"), "utf8");
		const original = await disk();
		const draft = "赤壁之战的天下，作者的草稿";
		const head = async () => (await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId;
		const discuss = async () =>
			(await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.discuss === true;

		await page.keyboard.press("Meta+t");
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("world/core.md");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await editor.fill(draft);
		const genesis = await head();

		assert.equal(await toggle.count(), 0, "新对话默认关着讨论，标记不占位置");
		await input.fill("/讨论");
		await page.keyboard.press("Enter");
		await pressed(true);
		assert.match(await toggle.innerText(), /讨论/);
		await input.fill("把核心设定改紧凑些");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByText("方案：核心设定的开头压短一句，关掉讨论再动手。", { exact: true }).waitFor();
		await eventually(discuss, "对话记下讨论开着");
		assert.equal(await disk(), original, "讨论开着时文件一个字没动，草稿也没被存盘");
		assert.equal(await editor.innerText(), draft);
		assert.equal(await head(), genesis);

		await toggle.click();
		await toggle.waitFor({ state: "detached" });
		await input.fill("照方案改");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByText("改好了，已经提交。", { exact: true }).waitFor();
		await eventually(async () => !(await discuss()), "对话记下讨论关上");
		assert.equal(await disk(), "赤壁之战的天下，作者的草稿，按方案压短\n");
		assert.notEqual(await head(), genesis, "关上讨论后 Agent 自己提交");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
