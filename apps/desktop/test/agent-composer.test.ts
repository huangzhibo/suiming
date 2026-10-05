import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, launchDesktop, openGate } from "./launch.js";

declare const window: { suiming?: DesktopBridge };
/** 测试的 tsconfig 不带 DOM 类型；只声明 page.evaluate 里用到的那几样。 */
interface PageElement {
	scrollTop: number;
	className: string;
	parentElement: PageElement | null;
	matches(selector: string): boolean;
	scrollIntoView(options: { block: "center" }): void;
}
declare const document: { querySelector(selector: string): PageElement | null };

test("原生对话：引用与附件、IME、迟到回包及发送重试、消息操作和阅读位置", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-composer-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const original = await readFile(join(root, "outline/story/vol-0001/beat-0001.md"), "utf8");
	const app = await launchDesktop({ directory, project: root, flags: ["--composer-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	const input = page.getByRole("textbox", { name: "输入消息", exact: true });
	const form = page.locator(".agent-composer");
	try {
		await page.getByRole("heading", { name: "beat-0001", exact: true }).waitFor();
		await page.getByRole("button", { name: "切换到编辑视图", exact: true }).click();
		await page.locator(".cm-content").fill(`${original}\n尚未保存的设计补充。`);
		await page.getByRole("button", { name: "添加内容", exact: true }).click();
		await page.getByRole("menuitem", { name: "引用当前文档", exact: true }).click();
		await page.getByRole("button", { name: "查看引用内容", exact: true }).click();
		await page.getByText(/文件内容 SHA-256/).waitFor();
		await page.getByText(/工作草稿，尚未保存/).waitFor();
		await page.keyboard.press("Escape");
		await input.fill("");
		await input.press("@");
		await page.getByRole("textbox", { name: "搜索作品引用", exact: true }).fill("诈降");
		await page
			.getByRole("dialog")
			.getByRole("button", { name: /诈降.*outline/ })
			.click();
		await page.getByRole("button", { name: "移除引用：诈降", exact: true }).click();
		assert.equal(await input.inputValue(), "");
		await form.locator('input[type="file"]').setInputFiles({
			name: "作者笔记.txt",
			mimeType: "text/plain",
			buffer: Buffer.from("外部笔记只作为会话输入。"),
		});
		await page.getByRole("button", { name: "查看引用内容", exact: true }).nth(1).waitFor();
		await form
			.locator('input[type="file"]')
			.setInputFiles({ name: "unsupported.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") });
		await form.getByText("读取失败", { exact: true }).waitFor();
		await page.getByRole("button", { name: "移除引用：unsupported.pdf", exact: true }).click();
		await input.fill("请根据引用分析主角的选择");
		await input.dispatchEvent("keydown", {
			key: "Enter",
			code: "Enter",
			metaKey: true,
			isComposing: true,
			keyCode: 229,
		});
		assert.equal((await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions.length, 0);
		await input.press("Meta+Enter");
		await form.getByText("正在确认本次发送，可以继续输入。", { exact: true }).waitFor();
		await input.fill("发送期间继续输入的补充要求。");
		await openGate(app, "composer-reply-lost");
		await form.getByText("测试：发送回包丢失", { exact: true }).waitFor();
		await page.reload();
		await input.waitFor();
		assert.equal(await input.inputValue(), "发送期间继续输入的补充要求。");
		await page.getByRole("button", { name: "确认发送结果", exact: true }).click();
		await openGate(app, "composer-first-reply");
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		assert.equal(await input.inputValue(), "发送期间继续输入的补充要求。");
		const state = await page.evaluate(() => window.suiming?.invoke("session.list", {}));
		assert.equal(state?.sessions.length, 1);
		const session = state?.sessions[0];
		assert.ok(session);
		const first = await page.evaluate((id) => window.suiming?.invoke("session.inbox", { sessionId: id }), session.id);
		assert.equal(first?.length, 1);
		assert.match(first?.[0]?.text ?? "", /尚未保存的设计补充/);
		assert.match(first?.[0]?.text ?? "", /外部笔记只作为会话输入/);
		assert.equal(await readFile(join(root, "outline/story/vol-0001/beat-0001.md"), "utf8"), original);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await form.getByText("测试：发送暂时失败", { exact: true }).waitFor();
		const queued = await page.evaluate(
			(id) => window.suiming?.invoke("session.inbox", { sessionId: id }),
			session.id,
		);
		assert.equal(queued?.length, 1, "发送失败的消息没有进 inbox");
		await input.fill("下一条草稿仍要保留。");
		await page.getByRole("button", { name: "确认发送结果", exact: true }).click();
		await page.locator(".message.assistant").filter({ hasText: "对话回看测试" }).first().waitFor();
		await page.locator(".run-status").getByText("等你继续", { exact: true }).waitFor();
		assert.equal(await input.inputValue(), "下一条草稿仍要保留。");
		const delivered = await page.evaluate(
			(id) => window.suiming?.invoke("session.inbox", { sessionId: id }),
			session.id,
		);
		assert.equal(delivered?.length, 2);
		assert.ok(delivered?.every((item) => item.delivered));
		const commands = await app.evaluate(
			() =>
				(
					globalThis as typeof globalThis & {
						composerTestCommands: { command: string; input: { commandId?: string; sessionId?: string } }[];
					}
				).composerTestCommands,
		);
		const sends = commands.filter((item) => item.command === "session.send");
		const opened = sends.filter((item) => item.input.sessionId === undefined);
		assert.equal(opened.length, 2, "回包丢失后确认发送沿用同一命令");
		assert.equal(opened[0]?.input.commandId, opened[1]?.input.commandId);
		const followUps = sends.filter((item) => item.input.sessionId !== undefined);
		assert.equal(followUps.length, 2, "失败后的重试沿用同一命令");
		assert.equal(followUps[0]?.input.commandId, followUps[1]?.input.commandId);
		const message = page.locator(".message.assistant").filter({ hasText: "对话回看测试" }).first();
		await message.waitFor();
		await page.getByRole("button", { name: "对话菜单", exact: true }).click();
		const exportedPath = join(directory, "对话.md");
		await app.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, exportedPath);
		await page.getByRole("menuitem", { name: "导出对话…", exact: true }).click();
		await page.getByText("对话已导出", { exact: true }).waitFor();
		assert.match(await readFile(exportedPath, "utf8"), /对话回看测试/);
		await message.getByRole("button", { name: "复制消息", exact: true }).click();
		await message.getByRole("button", { name: "已复制", exact: true }).waitFor();
		await message.getByRole("button", { name: "引用消息", exact: true }).click();
		await form.getByText("对话引用", { exact: true }).waitFor();
		const viewport = page.locator("[data-conversation-viewport]");
		await viewport.evaluate((element) => {
			element.scrollTop = 160;
		});
		await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
		await input.fill("输入框增高\n".repeat(8));
		assert.ok(Math.abs((await viewport.evaluate((element) => element.scrollTop)) - 160) < 2);
		// 模拟后续消息增长，检查 ResizeObserver 不会把正在回看的作者拉回底部。
		await viewport.evaluate((element) => {
			const body = element.firstElementChild;
			const extra = body?.lastElementChild?.cloneNode(true);
			if (body && extra) body.appendChild(extra);
		});
		// ResizeObserver 在下一帧绘制前回调：等两帧，不按固定时长。
		await page.evaluate(() => {
			const frame = (
				globalThis as unknown as { requestAnimationFrame(callback: () => void): number }
			).requestAnimationFrame.bind(globalThis);
			return new Promise<void>((done) => frame(() => frame(done)));
		});
		assert.ok(Math.abs((await viewport.evaluate((element) => element.scrollTop)) - 160) < 2);
		await page.reload();
		await page.locator(".message.assistant").filter({ hasText: "对话回看测试" }).waitFor();
		await page.waitForFunction(
			() => Math.abs((document.querySelector("[data-conversation-viewport]")?.scrollTop ?? 0) - 160) < 2,
		);
		await page.getByRole("button", { name: "回到最新", exact: true }).click();
		assert.ok(
			await viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop < 8),
		);
		// 消息里给读屏的「你 / 燧明」标签是绝对定位的。对话滚动区没有定位时，它们以外层为包含块、排到几千像素深，
		// 把 overflow: hidden 的右栏撑成「能被程序滚动」：任何 scrollIntoView（键盘聚焦、引用、自动化）都会把整栏推上去，
		// 输入框浮到中间、下面空出一块，又没有滚动条拉得回来（2026-10-05 模拟作者操作时撞到）。对话要比右栏长才暴露。
		await viewport.evaluate((element) => {
			const message = [...element.querySelectorAll(".message")].at(-1);
			for (let count = 0; count < 12 && message?.parentElement; count += 1)
				message.parentElement.appendChild(message.cloneNode(true));
		});
		await page.evaluate(() => document.querySelector("[data-composer-submit]")?.scrollIntoView({ block: "center" }));
		const shifted = await page.evaluate(() => {
			const moved: string[] = [];
			for (let element = document.querySelector("[data-composer-submit]"); element; element = element.parentElement)
				if (element.scrollTop > 0 && !element.matches("[data-conversation-viewport]"))
					moved.push(`${element.className} ↑${element.scrollTop}`);
			return moved;
		});
		assert.deepEqual(shifted, [], "输入框所在的右栏不能被程序滚动");
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ path: "/tmp/suiming-composer-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
