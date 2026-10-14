import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

test("动作详情的长路径与结果不会撑宽对话侧栏或主工作面", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-conversation-layout-"));
	const root = join(directory, "work");
	await mkdir(root);
	const files = sampleWorkFiles();
	const file = files.find((file) => file.path.endsWith("黄盖.md"));
	assert.ok(file);
	file.bytes = new TextEncoder().encode(
		`${new TextDecoder().decode(file.bytes)}\n${"unbroken-long-reference".repeat(150)}`,
	);
	await materializeOpenStoryDirectorySnapshot(root, files);
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--action-layout-test"] });
	const page = await app.firstWindow();
	const errors = collectPageErrors(page);
	try {
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		await input.fill("读取第一节");
		await input.press("Meta+Enter");
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const group = page.locator("details.activities");
		await group.locator(":scope > summary").click();
		await group.locator(".activity").filter({ hasText: "派出子任务" }).locator(":scope > summary").click();
		await group.locator(".activity").filter({ hasText: "读取文件" }).locator(":scope > summary").click();
		await page.locator(".action-detail").last().getByText("结果", { exact: true }).waitFor();
		for (const expanded of [false, true]) {
			if (expanded) await page.getByRole("button", { name: "展开为主工作面", exact: true }).click();
			const geometry = await page.locator("[data-conversation-viewport]").evaluate((element) => {
				const node = element as unknown as { scrollWidth: number; clientWidth: number; scrollLeft: number };
				return { content: node.scrollWidth, viewport: node.clientWidth, left: node.scrollLeft };
			});
			assert.ok(geometry.content <= geometry.viewport + 1, JSON.stringify({ expanded, ...geometry }));
			assert.equal(geometry.left, 0);
			if (process.env.SUIMING_CAPTURE_DIR) {
				await mkdir(process.env.SUIMING_CAPTURE_DIR, { recursive: true });
				await page.screenshot({
					path: join(
						process.env.SUIMING_CAPTURE_DIR,
						`conversation-detail-${expanded ? "expanded" : "sidebar"}.png`,
					),
				});
			}
		}
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
