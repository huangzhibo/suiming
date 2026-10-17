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

// ADR-0038 决定一：在输入框选协作模式。讨论模式下 Agent 硬要写也写不进去、不替作者存草稿；
// 协作模式下改进候选但不提交，作者用「提交版本」提交。faux 模型的越界动作在 entry.ts 的 --collaboration-mode-test。
test("协作模式：讨论只读不碰草稿，协作改候选由作者提交", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-collaboration-mode-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--collaboration-mode-test"] });
	try {
		const page = await app.firstWindow();
		page.setDefaultTimeout(10000);
		const errors = collectPageErrors(page);
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		const editor = page.getByLabel("编辑文件内容", { exact: true });
		const disk = () => readFile(join(root, "world/core.md"), "utf8");
		const original = await disk();
		const draft = "赤壁之战的天下，作者的草稿";
		const head = async () => (await page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId;
		const mode = async () =>
			(await page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions[0]?.collaboration ??
			"autonomous";
		const choose = async (label: string, value: string) => {
			await page.getByRole("button", { name: "协作模式", exact: true }).click();
			await page.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }).click();
			await page.locator(`[data-collaboration-mode="${value}"]`).waitFor();
		};

		await page.keyboard.press("Meta+t");
		await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("world/core.md");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await editor.fill(draft);
		const genesis = await head();

		await choose("讨论", "discuss");
		assert.equal(await page.getByRole("button", { name: "协作模式", exact: true }).innerText(), "讨论");
		await input.fill("把核心设定改紧凑些");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByText("方案：核心设定的开头压短一句，切到协作再动手。", { exact: true }).waitFor();
		await eventually(async () => (await mode()) === "discuss", "对话记下讨论模式");
		assert.equal(await disk(), original, "讨论模式下文件一个字没动，草稿也没被存盘");
		assert.equal(await editor.innerText(), draft);
		assert.equal(await head(), genesis);

		await choose("协作", "collaborate");
		await input.fill("照方案改");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await page.getByText("改好了，候选里改了核心设定，等你提交。", { exact: true }).waitFor();
		await eventually(async () => (await mode()) === "collaborate", "对话换成协作模式");
		assert.equal(await disk(), "赤壁之战的天下，作者的草稿，按方案压短\n");
		assert.equal(await head(), genesis, "协作模式下 Agent 没有提交");

		await page.getByRole("button", { name: "提交版本", exact: true }).click();
		await eventually(async () => (await head()) !== genesis, "作者提交后成为新版本");
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
