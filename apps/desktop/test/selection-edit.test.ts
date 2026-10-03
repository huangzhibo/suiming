import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { _electron as electron } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

declare const window: { suiming?: DesktopBridge };

test("正文选段就地修改：选段栏写要求、回车直接发给 Agent；输入框有草稿时接进输入框，不顶掉", {
	timeout: 90000,
}, async () => {
	// 2026-10-03 作者参照 Codex 的就地编辑：选中后直接写一句要求发出，不必挪到右侧输入框再组织一遍。
	const directory = await mkdtemp(join(tmpdir(), "suiming-selection-edit-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	await mkdir(join(root, "text"), { recursive: true });
	await writeFile(join(root, "text/beat-0001.md"), "李牧推开皇档的门。霉味先于灯光涌出来。\n\n他伸手取了信。\n");
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			"--selection-edit-test",
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app-data")}`,
		],
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const body = page.locator('[data-scroll-key="body:text"]');
	const select = (length: number) =>
		body.evaluate((element, size) => {
			const node = element.querySelector("p")?.firstChild;
			if (node) element.ownerDocument.getSelection()?.setBaseAndExtent(node, 0, node, size);
		}, length);
	const request = page.getByRole("textbox", { name: "说明要怎么改", exact: true });
	const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
	try {
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await body.locator("p").first().waitFor();

		await select(9);
		await request.fill("门前先停一下再推门");
		// 中文输入法确认候选字的回车不发送
		await request.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
		assert.equal((await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions.length, 0);
		await request.press("Enter");
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		const sessions = (await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions ?? [];
		assert.equal(sessions.length, 1);
		const inbox = await page.evaluate(
			(id) => window.suiming?.invoke("session.inbox", { sessionId: id }),
			sessions[0]?.id as string,
		);
		const sent = inbox?.[0]?.text ?? "";
		assert.match(sent, /请修改这一段：门前先停一下再推门/);
		assert.match(sent, /作品引用：text\/beat-0001\.md/, "带着选段的定位");
		assert.match(sent, /李牧推开皇档的门。/);
		assert.match(await readFile(join(root, "text/beat-0001.md"), "utf8"), /李牧在皇档门前停了一下，才推开门。/);
		assert.equal(await composer.inputValue(), "", "就地发送不经过输入框，也不在里面留东西");

		// 输入框里有作者没发出的话：就地要求接进输入框，选段成为引用，不直接发出、不顶掉草稿
		await composer.fill("另外想问问后面的节奏");
		await select(4);
		await request.fill("这里改得更紧");
		await request.press("Enter");
		assert.match(await composer.inputValue(), /^另外想问问后面的节奏\n请修改这一段：这里改得更紧$/);
		await page.getByRole("button", { name: "查看引用内容", exact: true }).waitFor();
		assert.equal(
			(
				await page.evaluate(
					(id) => window.suiming?.invoke("session.inbox", { sessionId: id }),
					sessions[0]?.id as string,
				)
			)?.length,
			1,
			"没有发出第二条",
		);
		assert.deepEqual(errors, []);
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
