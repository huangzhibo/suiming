import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, openGate } from "./launch.js";

declare const window: { suiming: DesktopBridge };
type TestGlobal = typeof globalThis & {
	testGateReached(name: string): boolean;
	workspaceTestCallbacks: { command: string; release?: () => void };
};
async function fixture(race = false, story = false) {
	const directory = await mkdtemp(join(tmpdir(), "suiming-ui-agent-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	await writeFile(join(root, "甲.md"), "甲的原文");
	await writeFile(join(root, "乙.md"), "乙的第一行\n乙的第二行\n乙的第三行");
	if (story) {
		await mkdir(join(root, "text"));
		await writeFile(join(root, "text/beat-0001.md"), "乙的第一行\n乙的第二行\n乙的第三行");
	}
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({
		directory,
		project: root,
		flags: [
			"--workspace-callback-test",
			race ? "--workbench-race-test" : "--workbench-test",
			...(story ? ["--workbench-story-test"] : []),
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
	await page.keyboard.press("Meta+t");
	await page.getByRole("textbox", { name: "搜索对象或文件", exact: true }).fill("甲.md");
	await page.keyboard.press("Enter");
	await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
	const editor = page.getByLabel("编辑文件内容", { exact: true });
	await editor.fill("甲的作者草稿");
	const tab = await page.locator('.tab-btn[data-active="true"]').getAttribute("data-tab-id");
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	const reached = (name: string) =>
		eventually(() => app.evaluate((_, name) => (globalThis as TestGlobal).testGateReached(name), name), name);
	const send = async () => {
		await input.fill("请定位乙的第二行，然后给我看看甲的草稿和磁盘差异");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await reached("ui-open");
	};
	const close = async () => {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	};
	return { app, page, root, editor, tab, input, reached, send, errors, close };
}

test("Agent 界面上下文与操作：源码定位、差异、返回及重载保留草稿和继续输入", { timeout: 90000 }, async () => {
	const f = await fixture();
	try {
		const before = await f.page.evaluate(() => window.suiming.invoke("workspace.show", {}));
		await f.send();
		await f.page.getByRole("button", { name: "展开为主工作面", exact: true }).click();
		await f.input.fill("尚未发送的下一句");
		await openGate(f.app, "ui-open");
		await f.reached("ui-diff");
		assert.equal(await f.page.locator(".tab-btn").filter({ hasText: "乙.md" }).count(), 1, "重复定位复用已有标签");
		assert.match(await f.editor.innerText(), /乙的第二行/);
		await f.page.locator(".cm-selectionBackground").first().waitFor({ state: "visible" });
		assert.equal(
			await f.input.evaluate((e) => e === e.ownerDocument.activeElement),
			true,
			"定位没有抢走对话输入焦点",
		);
		assert.equal(await f.input.inputValue(), "尚未发送的下一句");
		await f.page.getByRole("button", { name: "查看自动附带的界面上下文" }).click();
		await f.page.getByText("选区：", { exact: false }).first().waitFor();
		await f.page.locator('[data-slot="popover-content"]').evaluate(async (node) => {
			await Promise.all(node.getAnimations().map((animation: { finished: Promise<unknown> }) => animation.finished));
		});
		await f.page.screenshot({ path: join(tmpdir(), "suiming-ui-context-preview.png") });
		await f.page.keyboard.press("Escape");
		await f.input.focus();
		await openGate(f.app, "ui-diff");
		await f.page.getByText("已定位第二行并展示草稿与磁盘差异，文件未修改。", { exact: true }).waitFor();
		await f.page.locator(".cm-mergeView").waitFor();
		assert.equal(await readFile(join(f.root, "甲.md"), "utf8"), "甲的原文");
		assert.equal(await f.input.evaluate((e) => e === e.ownerDocument.activeElement), true);
		await f.page.locator(`[data-tab-id="${f.tab}"]`).click();
		assert.equal(await f.editor.innerText(), "甲的作者草稿");
		await f.page.reload();
		await f.editor.waitFor();
		assert.equal(await f.editor.innerText(), "甲的作者草稿");
		assert.equal(await f.input.inputValue(), "尚未发送的下一句");
		assert.equal(
			(await f.page.evaluate(() => window.suiming.invoke("workspace.show", {}))).revisionId,
			before.revisionId,
		);
		assert.deepEqual(f.errors, []);
	} finally {
		await f.close();
	}
});

for (const change of ["navigate", "reload", "stop"] as const)
	test(`迟到的界面操作：${change} 后不打开目标，不改变作者草稿`, { timeout: 60000 }, async () => {
		const f = await fixture(true);
		try {
			await f.send();
			await f.app.evaluate(() => {
				(globalThis as TestGlobal).workspaceTestCallbacks.command = "workspace.file.read";
			});
			await openGate(f.app, "ui-open");
			await eventually(
				() => f.app.evaluate(() => !!(globalThis as TestGlobal).workspaceTestCallbacks.release),
				"导航读取被截住",
			);
			if (change === "navigate") await f.page.keyboard.press("Meta+t");
			else if (change === "reload") await f.page.reload();
			else {
				const sessions = await f.page.evaluate(() => window.suiming.invoke("session.list", {}));
				const session = sessions.sessions.at(-1);
				assert.ok(session);
				await f.page.evaluate((id) => window.suiming.invoke("session.interrupt", { sessionId: id }), session.id);
			}
			await f.app.evaluate(() => (globalThis as TestGlobal).workspaceTestCallbacks.release?.());
			if (change !== "stop") await f.page.getByText("作者现场已变化，未执行迟到导航。", { exact: true }).waitFor();
			else
				await eventually(
					async () =>
						(await f.page.evaluate(() => window.suiming.invoke("session.list", {}))).sessions.every(
							(s) => s.status === "idle",
						),
					"停止结束",
				);
			assert.equal(await f.page.locator(".tab-btn").filter({ hasText: "乙.md" }).count(), 0);
			await f.page.locator(`[data-tab-id="${f.tab}"]`).click();
			assert.equal(await f.editor.innerText(), "甲的作者草稿");
			assert.equal(await readFile(join(f.root, "甲.md"), "utf8"), "甲的原文");
			assert.deepEqual(f.errors, []);
		} finally {
			await f.close();
		}
	});

test("Agent 自动定位正文只高亮，作者重新选段后才出现就地修改操作", { timeout: 60000 }, async () => {
	const f = await fixture(false, true);
	try {
		await f.send();
		await f.input.fill("继续在对话框输入");
		await openGate(f.app, "ui-open");
		await f.reached("ui-diff");
		await f.page.locator(".cm-selectionBackground").first().waitFor();
		assert.equal(await f.page.getByRole("textbox", { name: "说明要怎么改", exact: true }).count(), 0);
		assert.equal(await f.input.evaluate((e) => e === e.ownerDocument.activeElement), true);
		await f.editor.focus();
		await f.editor.press("Meta+a");
		await f.page.getByRole("textbox", { name: "说明要怎么改", exact: true }).waitFor();
		assert.equal(await f.input.inputValue(), "继续在对话框输入");
		await openGate(f.app, "ui-diff");
		await f.page.getByText("已定位第二行并展示草稿与磁盘差异，文件未修改。", { exact: true }).waitFor();
		assert.deepEqual(f.errors, []);
	} finally {
		await f.close();
	}
});
