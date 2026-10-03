import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { _electron as electron } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

declare const window: { suiming?: DesktopBridge };

test("连续对话：停下后追问接着同一 session、重载历史、草稿隔离、停止与再发一句", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-conversation-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			"--conversation-test",
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	const read = () => page.evaluate(() => window.suiming?.invoke("session.list", {}));
	try {
		await input.fill("讨论李牧公开密信的选择");
		await input.press("Meta+Enter");
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const first = (await read())?.sessions[0];
		assert.ok(first);
		await input.fill("这个方案还有什么问题？");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "接着刚才的方案" }).waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const state = await read();
		assert.equal(state?.sessions.length, 1, "追问接着同一个 session，不新开");
		assert.equal(state?.sessions[0]?.turn, 2);
		assert.equal((await page.evaluate(() => window.suiming?.invoke("workspace.show", {})))?.revisions.length, 1);
		assert.equal(await page.locator(".message.user").count(), 2);
		assert.equal(await page.locator(".message.assistant").count(), 2);
		assert.equal(await page.locator("details.activities[open]").count(), 0);
		assert.equal(await page.getByText(/约束本作品的所有/).count(), 0);
		await input.fill("这个对话的未发送草稿");
		await page.reload();
		await page.locator(".message.assistant").filter({ hasText: "接着刚才的方案" }).waitFor();
		assert.equal(await input.inputValue(), "这个对话的未发送草稿");
		await page.getByRole("button", { name: "展开为主工作面", exact: true }).click();
		if (process.env.SUIMING_CAPTURE_DIR) {
			await mkdir(process.env.SUIMING_CAPTURE_DIR, { recursive: true });
			await page.screenshot({ path: join(process.env.SUIMING_CAPTURE_DIR, "01-expanded.png") });
		}
		await page.getByRole("button", { name: "收回为侧栏", exact: true }).click();
		await page.getByRole("button", { name: "新对话", exact: true }).click();
		assert.equal(await input.inputValue(), "");
		assert.equal(await page.locator(".message.assistant").count(), 0);
		await input.fill("聊聊叙事节奏");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "这是独立的新对话" }).waitFor();
		const other = (await read())?.sessions.at(-1);
		assert.notEqual(other?.id, first.id);
		assert.equal((await read())?.sessions.length, 2);
		await page.getByRole("button", { name: "选择对话", exact: true }).click();
		await page
			.getByRole("button", { name: /讨论李牧公开密信的选择/ })
			.last()
			.click();
		assert.equal(await input.inputValue(), "这个对话的未发送草稿");
		await page.locator(".message.assistant").filter({ hasText: "接着刚才的方案" }).waitFor();
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({ path: join(process.env.SUIMING_CAPTURE_DIR, "02-sidebar.png") });
		await input.fill("继续分析这个选择");
		await input.press("Meta+Enter");
		await page.getByRole("button", { name: "停止", exact: true }).click();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const stopped = (await read())?.sessions.find((session) => session.id === first.id);
		assert.equal(stopped?.status, "idle", "作者的停止不是故障，回 idle");
		assert.equal(stopped?.lastFailure, undefined);
		await input.fill("接着说");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "接着停下前的分析" }).waitFor();
		assert.equal((await read())?.sessions.find((session) => session.id === first.id)?.status, "idle");
		assert.equal((await read())?.sessions.find((session) => session.id === first.id)?.turn, 4);
		assert.equal(await page.getByText("停止没有生效").count(), 0);
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-conversation-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
