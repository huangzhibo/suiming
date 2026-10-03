import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { _electron as electron } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

declare const window: { suiming: DesktopBridge };

test("一个 turn 跑完回 idle；执行更新不反复扫描作品", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-run-controls-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			"--product-audit-test",
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app")}`,
		],
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		const sent = await page.evaluate(() =>
			window.suiming.invoke("session.send", { commandId: "audit-flow", text: "核对作品" }),
		);
		await page.getByRole("button", { name: "选择对话", exact: true }).click();
		await page.getByRole("button", { name: /核对作品/ }).click();
		await page.locator(".message.assistant").filter({ hasText: "已核对作品状态" }).first().waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		await page.screenshot({ path: "/tmp/suiming-session-controls.png" });
		let idle = false;
		for (let i = 0; i < 100; i++) {
			idle = await page.evaluate(
				async (id) =>
					(await window.suiming.invoke("session.list", {})).sessions.some(
						(session) => session.id === id && session.status === "idle" && session.turn === 1,
					),
				sent.sessionId,
			);
			if (idle) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(idle);
		const verified = await LocalProjectService.open(root);
		assert.equal(verified.loadExecutionState().sessions.length, 1);
		assert.equal(verified.loadExecutionState().sessions[0]?.usage?.calls, 1);
		assert.deepEqual(verified.loadExecutionState().tasks, []);
		verified.close();
		const commands = await app.evaluate(
			() => (globalThis as typeof globalThis & { productAuditCommands: string[] }).productAuditCommands,
		);
		assert.ok(
			commands.filter((command) => command === "workspace.show").length <= 6,
			"仅初始化、命令确认与收尾刷新作品，流式文字不扫描目录",
		);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
