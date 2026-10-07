import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, openGate } from "./launch.js";

declare const window: { suiming?: DesktopBridge };

test("子任务停下再续做：对话里是先后两段，前一段标已停下，续的那段以续做开头；进行中点开的动作并成「读取文件 2 次」后照旧展开", {
	timeout: 60000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-subtask-resume-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--subtask-resume-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	try {
		await input.fill("读一下黄盖和阚泽的人物档");
		await input.press("Meta+Enter");
		const running = page.locator("details.activities");
		await running.locator(":scope > summary").waitFor();
		await running.locator(":scope > summary").click();
		// 子任务读完第一个文件停在闸门上：点开这一行，再放第二次读取进来
		const firstRead = running.locator("details.activity").filter({ hasText: "读取文件" });
		await firstRead.locator("summary").click();
		await firstRead.locator(".action-detail").filter({ hasText: "黄盖" }).waitFor();
		await openGate(app, "subtask-second-read");
		const run = running.locator("details.activity-run").filter({ hasText: "读取文件 2 次" });
		await run.waitFor();
		assert.equal(await run.getAttribute("open"), "", "并成一行之后照旧展开");
		await run.locator("details.activity[open] .action-detail").filter({ hasText: "黄盖" }).waitFor();

		await page.getByRole("button", { name: "停止", exact: true }).click();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		await input.fill("继续");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "两个人物都读过了" }).waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();

		const sessionId = (await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions[0]?.id;
		assert.ok(sessionId);
		const tasks = await page.evaluate((id) => window.suiming?.invoke("session.tasks", { sessionId: id }), sessionId);
		assert.deepEqual(
			tasks?.map((task) => task.status),
			["completed"],
			"续的是原来那个子任务，没有新建",
		);
		const segments = page.locator(`details.activities[data-task-id="${tasks?.[0]?.id}"]`);
		await eventually(async () => (await segments.count()) === 2, "子任务应是先后两段");
		const [stopped, resumed] = [segments.nth(0), segments.nth(1)];
		assert.match(await stopped.locator(":scope > summary").innerText(), /已停下/u);
		assert.doesNotMatch(await resumed.locator(":scope > summary").innerText(), /已停下|进行中/u);
		// 前一段（作者点开过，仍展开着）以委派开头，被打断；续的那段以续做开头，交回的结果在它里面
		await stopped.locator("details.activity").filter({ hasText: "派出子任务" }).waitFor();
		assert.equal(await stopped.getByText("续做子任务").count(), 0);
		await resumed.locator(":scope > summary").click();
		const opener = resumed.locator("details.activity").first();
		assert.match(await opener.locator("summary").innerText(), /续做子任务/u);
		await opener.locator("summary").click();
		await opener.locator(".action-detail").filter({ hasText: "两个人物档都读过了" }).waitFor();
		// 根 Agent 的动作里不再单列这两次
		assert.equal(
			await page
				.locator(".transcript > .actions")
				.filter({ hasText: /派出子任务|续做子任务/u })
				.count(),
			0,
		);
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-subtask-resume-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
