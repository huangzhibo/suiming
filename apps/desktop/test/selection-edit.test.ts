import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop } from "./launch.js";

declare const window: { suiming?: DesktopBridge };
declare const innerWidth: number;

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
	await writeFile(
		join(root, "text/beat-0001.md"),
		`军杖落到第三十下。黄盖咬住了衣角。\n\n他一声没吭。\n\n${"营门外静了下来。\n\n".repeat(24)}`,
	);
	const designPath = "outline/story/vol-0001/beat-0001.md";
	await writeFile(join(root, designPath), `${await readFile(join(root, designPath), "utf8")}\n## 军帐中的转折\n`);
	const app = await launchDesktop({ directory, project: root, flags: ["--selection-edit-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const body = page.locator('[data-scroll-key="body:text"]');
	const request = page.getByRole("textbox", { name: "说明要怎么改", exact: true });
	const popup = page.locator("[data-reading-edit]");
	const composer = page.getByRole("textbox", { name: "输入消息", exact: true });
	try {
		await page.locator('.beat-row[data-page$="beat-0001.md"]').click();
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("radio", { name: "正文", exact: true }).click();
		await body.locator("p").first().waitFor();

		const line = await body
			.locator("p")
			.first()
			.evaluate((element) => {
				const node = element.firstChild;
				if (!node) throw new Error("缺少用于拖选的正文");
				const range = element.ownerDocument.createRange();
				range.setStart(node, 0);
				range.setEnd(node, 9);
				const rect = range.getBoundingClientRect();
				return { start: rect.left + 1, end: rect.right - 1, y: rect.top + rect.height / 2 };
			});
		await page.mouse.move(line.start, line.y);
		await page.mouse.down();
		await page.mouse.move(line.end, line.y, { steps: 8 });
		assert.equal(await popup.count(), 0, "拖选时浮层不挡住文字");
		await page.mouse.up();
		await popup.and(page.locator('[data-side="top"]')).waitFor();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 740));
		await page.waitForFunction(() => innerWidth === 960);
		await body.evaluate((element) => {
			const paragraph = element.querySelector("p");
			if (paragraph)
				element.scrollTop += paragraph.getBoundingClientRect().top - element.getBoundingClientRect().top - 2;
		});
		await popup.and(page.locator('[data-side="bottom"]')).waitFor();
		const narrowPopup = await popup.boundingBox();
		const narrowBody = await body.boundingBox();
		assert.ok(narrowPopup && narrowBody && narrowPopup.x >= narrowBody.x);
		assert.ok(narrowPopup.x + narrowPopup.width <= narrowBody.x + narrowBody.width);
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
		assert.match(sent, /军杖落到第三十下。/);
		// 发给 Agent 的带版本与内容 SHA，作者自己的气泡里只有原话，选段折成「标题 · 第几段选段」的标签。
		const bubble = page.locator(".message.user").first();
		assert.doesNotMatch(await bubble.innerText(), /contentSHA|revision:/u);
		await bubble.getByText(/ · 正文 · 第 1 段选段$/u).waitFor();
		assert.match(await readFile(join(root, "text/beat-0001.md"), "utf8"), /军杖落下之前，黄盖抬头看了周瑜一眼。/);
		assert.equal(await composer.inputValue(), "", "就地发送不经过输入框，也不在里面留东西");

		// 输入框里有作者没发出的话：就地要求接进输入框，选段成为引用，不直接发出、不顶掉草稿
		await composer.fill("另外想问问后面的节奏");
		const paragraph = body.locator("p").first();
		const paragraphText = await paragraph.innerText();
		await paragraph.hover();
		await body.getByRole("button", { name: "请 Agent 修改", exact: true }).click();
		await request.waitFor();
		assert.equal(await request.evaluate((input) => input.ownerDocument.activeElement === input), true);
		await request.fill("这里改得更紧");
		await request.press("Enter");
		assert.match(await composer.inputValue(), /^另外想问问后面的节奏\n请修改这一段：这里改得更紧$/);
		const references = page.getByRole("button", { name: "查看引用内容", exact: true });
		await references.first().click();
		const quote = page.locator(".reference-preview");
		await quote.waitFor();
		assert.ok((await quote.innerText()).endsWith(paragraphText), "块入口引用整段正文");
		await page.keyboard.press("Escape");

		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1800, 940));
		await page.waitForFunction(() => innerWidth === 1800);
		await paragraph.evaluate((element) => {
			const node = element.firstChild;
			if (node) element.ownerDocument.getSelection()?.setBaseAndExtent(node, 0, node, 4);
		});
		await request.waitFor();
		const heading = page.getByRole("heading", { name: "军帐中的转折", exact: true });
		await page.getByRole("radio", { name: "设计", exact: true }).click();
		await heading.waitFor();
		assert.equal(
			await heading.evaluate(
				(element) =>
					new Promise<boolean>((resolve) =>
						element.ownerDocument.defaultView?.requestAnimationFrame(() =>
							resolve(
								element
									.closest("[data-prose]")
									?.contains(element.ownerDocument.getSelection()?.anchorNode ?? null) ?? false,
							),
						),
					),
			),
			false,
			"正文选区不会恢复到设计文件",
		);
		await page.locator('[data-pane-active="true"]').getByRole("button", { name: "更多", exact: true }).click();
		await page.getByRole("menuitem", { name: "并排查看设计与正文", exact: true }).click();
		const design = page.locator("[data-pane-id]").filter({ has: heading });
		await heading.hover();
		await design.getByRole("button", { name: "请 Agent 修改", exact: true }).click();
		await request.waitFor();
		const popupBox = await popup.boundingBox();
		const designBox = await design.boundingBox();
		assert.ok(
			popupBox &&
				designBox &&
				popupBox.x >= designBox.x &&
				popupBox.x + popupBox.width <= designBox.x + designBox.width,
		);
		await request.fill("标题再具体一点");
		await request.press("Enter");
		await references.last().click();
		await quote.waitFor();
		assert.ok((await quote.innerText()).includes(`作品引用：${designPath}`));
		assert.ok((await quote.innerText()).endsWith("军帐中的转折"), "块入口引用整条设计标题");
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
