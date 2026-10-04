import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop } from "./launch.js";

declare const window: { suiming?: DesktopBridge };

test("模型选择与设置：单对话选择、思考深度、窄栏布局与新对话默认", { timeout: 60000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-model-picker-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await launchDesktop({ directory, project: root, flags: ["--model-picker-test"] });
	const page = await app.firstWindow();
	page.setDefaultTimeout(10000);
	const errors = collectPageErrors(page);
	try {
		const picker = page.getByRole("button", { name: "对话模型", exact: true });
		await picker.waitFor();
		assert.match(await picker.innerText(), /测试模型 A/);
		await picker.click();
		await page.getByRole("option", { name: "测试模型 B", exact: true }).click();
		assert.equal(
			await page.getByRole("combobox", { name: "思考强度", exact: true }).innerText(),
			"低",
			"换模型保留兼容的思考强度",
		);
		await page.getByRole("combobox", { name: "思考强度", exact: true }).click();
		await page.getByRole("option", { name: "高", exact: true }).click();
		await page.reload();
		await picker.waitFor();
		assert.match(await picker.innerText(), /测试模型 B/);
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		await input.fill("讨论一下人物的选择");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "模型 B 已按高思考深度完成讨论" }).waitFor();
		const settings = await page.evaluate(() => window.suiming?.invoke("models.show", {}));
		assert.equal(settings?.profiles.find((profile) => profile.id === "main")?.model, "first");
		assert.equal(settings?.profiles.find((profile) => profile.id === "main")?.thinking, "low");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1080, 800));
		const composer = page.locator('[data-variant="composer"]');
		assert.equal(
			await composer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
			true,
			"窄侧栏不应横向溢出",
		);
		if (process.env.SUIMING_CAPTURE_DIR) {
			await mkdir(process.env.SUIMING_CAPTURE_DIR, { recursive: true });
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "01-model-sidebar.png"),
			});
		}
		await picker.click();
		if (process.env.SUIMING_CAPTURE_DIR) {
			await page.getByRole("dialog").evaluate(async (element) => {
				await Promise.all(
					element
						.getAnimations({ subtree: true })
						.map((animation: { finished: Promise<unknown> }) => animation.finished.catch(() => undefined)),
				);
			});
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "03-model-picker.png"),
			});
		}
		await page.getByRole("button", { name: "模型设置…", exact: true }).click();
		await page.getByRole("form", { name: "默认对话模型", exact: true }).waitFor();
		await page.getByRole("dialog").evaluate(async (element) => {
			await Promise.all(
				element
					.getAnimations({ subtree: true })
					.map((animation: { finished: Promise<unknown> }) => animation.finished.catch(() => undefined)),
			);
		});
		assert.equal(await page.getByRole("tabpanel", { name: "任务偏好", exact: true }).isVisible(), false);
		// 每轮用量检查点在默认模型下面：选了就写进 config.toml，下一轮开始时读。
		const checkpoint = page.getByRole("combobox", { name: "每轮用量检查点", exact: true });
		assert.match(await checkpoint.innerText(), /600 万（默认）/);
		await checkpoint.click();
		await page.getByRole("option", { name: /^2,000 万/ }).click();
		await page.getByText("已保存，下一轮生效", { exact: true }).waitFor();
		assert.match(await readFile(join(directory, "config.toml"), "utf8"), /usage_checkpoint = 20000000/);
		assert.match(await checkpoint.innerText(), /2,000 万/);
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "02-model-settings.png"),
			});
		await page.getByRole("tab", { name: "任务偏好", exact: true }).click();
		assert.equal(await page.getByRole("tabpanel", { name: "任务偏好", exact: true }).getByRole("form").count(), 5);
		assert.equal(await page.getByRole("button", { name: "管理连接", exact: true }).count(), 0);
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "06-task-preferences.png"),
			});
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "新对话", exact: true }).click();
		assert.match(await picker.innerText(), /测试模型 A/);
		await input.fill("继续聊一个新问题");
		await input.press("Meta+Enter");
		await page.locator(".message.assistant").filter({ hasText: "新对话使用模型 A 和低思考深度" }).waitFor();

		// 对话只保留模型菜单这一处配置入口；进入设置不丢失未发送输入。
		await input.fill("保留这段未发送的草稿");
		assert.equal(await page.getByRole("button", { name: "模型配置", exact: true }).count(), 0);
		await picker.click();
		await page.getByRole("button", { name: "模型设置…", exact: true }).click();
		const form = page.getByRole("form", { name: "默认对话模型", exact: true });
		await form.getByRole("combobox", { name: "模型", exact: true }).click();
		await page.getByRole("combobox", { name: "搜索模型", exact: true }).fill("不存在的模型");
		await page.getByText("没有匹配的模型，试试其他名称。", { exact: true }).waitFor();
		await page.getByRole("combobox", { name: "搜索模型", exact: true }).fill("测试模型 B");
		await page.getByRole("combobox", { name: "搜索模型", exact: true }).press("Enter");
		assert.match(await form.getByRole("combobox", { name: "模型", exact: true }).innerText(), /测试模型 B/);
		await page.keyboard.press("Escape");
		await page.getByRole("tab", { name: /提供商/ }).click();
		assert.equal(await page.getByRole("button", { name: "配置 示例提供商", exact: true }).count(), 0);
		await page.getByRole("button", { name: "添加提供商", exact: true }).click();
		await page.getByRole("textbox", { name: "搜索提供商" }).fill("不匹配");
		await page.getByText("没有匹配的提供商，试试其他名称。", { exact: true }).waitFor();
		await page.getByRole("textbox", { name: "搜索提供商" }).fill("");
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "04-provider-list.png"),
			});
		await page.getByRole("button", { name: "配置 示例提供商", exact: true }).click();
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "04-providers.png"),
			});
		await page.getByRole("button", { name: "输入 API key", exact: true }).click();
		const secret = page.getByRole("textbox", { name: "输入测试 API key", exact: true });
		await secret.waitFor();
		assert.equal(await secret.getAttribute("type"), "password");
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "05-provider-login.png"),
			});
		await secret.fill("invalid-test-key");
		await page.getByRole("button", { name: "提交", exact: true }).click();
		await page.getByText("测试连接失败，请重新输入", { exact: true }).waitFor();
		await page.getByRole("button", { name: "关闭", exact: true }).click();
		await page.getByRole("button", { name: "输入 API key", exact: true }).click();
		await secret.fill("test-only-key");
		await page.getByRole("button", { name: "提交", exact: true }).click();
		await page.getByText("API key · 本地保存", { exact: true }).waitFor();
		await page.getByRole("button", { name: "关闭", exact: true }).click();
		const connected = await page.evaluate(() => window.suiming?.invoke("models.show", {}));
		assert.equal(connected?.providers.find((item) => item.id === "connection-test")?.stored, "api_key");
		assert.equal(JSON.stringify(connected).includes("test-only-key"), false);
		// 停用不会删除凭据；选择器和 Runtime 同时拒绝新绑定，重新开启可恢复。
		await page.getByRole("button", { name: "返回提供商", exact: true }).click();
		const enabledSwitch = page.getByRole("switch", { name: "启用 示例提供商", exact: true });
		await enabledSwitch.click();
		await eventually(
			async () =>
				(await page.evaluate(() => window.suiming?.invoke("models.show", {})))?.providers.find(
					(item) => item.id === "connection-test",
				)?.enabled === false,
			"提供商的启用状态没有变成 false",
		);
		assert.equal(
			(await page.evaluate(() => window.suiming?.invoke("models.show", {})))?.providers.find(
				(item) => item.id === "connection-test",
			)?.stored,
			"api_key",
		);
		if (process.env.SUIMING_CAPTURE_DIR)
			await page.screenshot({
				animations: "disabled",
				path: join(process.env.SUIMING_CAPTURE_DIR, "07-provider-disabled.png"),
			});
		const rejected = await page.evaluate(async () => {
			try {
				await window.suiming?.invoke("session.send", {
					commandId: "disabled-provider",
					text: "此调用不应启动",
					model: { provider: "connection-test", model: "story-model-with-a-long-id" },
				});
				return "未拒绝";
			} catch (error) {
				// bridge 拒绝的是普通对象：Error 过 contextBridge 会丢掉 code（见 DesktopCommandFailure）。
				const failure = error as { code: string; message: string };
				return `${failure.code}：${failure.message}`;
			}
		});
		assert.match(rejected, /^model_provider_disabled：.*已停用/);
		await page.getByRole("tab", { name: "模型配置", exact: true }).click();
		await form.getByRole("combobox", { name: "模型", exact: true }).click();
		assert.equal(await page.getByRole("option", { name: "示例故事模型 · 长名称排版验证", exact: true }).count(), 0);
		await page.keyboard.press("Escape");
		await page.getByRole("tab", { name: /提供商/ }).click();
		await enabledSwitch.click();
		await eventually(
			async () =>
				(await page.evaluate(() => window.suiming?.invoke("models.show", {})))?.providers.find(
					(item) => item.id === "connection-test",
				)?.enabled === true,
			"提供商的启用状态没有变成 true",
		);
		await page.getByRole("tab", { name: "模型配置", exact: true }).click();
		await form.getByRole("combobox", { name: "模型", exact: true }).click();
		await page.getByRole("option", { name: "示例故事模型 · 长名称排版验证", exact: true }).click();
		assert.equal(
			await page.getByRole("combobox", { name: "思考强度", exact: true }).count(),
			0,
			"不支持思考强度的模型隐藏控件",
		);
		await page.getByRole("option", { name: "测试模型 B", exact: true }).click();
		assert.equal(await page.getByRole("combobox", { name: "思考强度", exact: true }).innerText(), "模型默认");
		await page.keyboard.press("Escape");
		assert.match(await form.getByRole("combobox", { name: "模型", exact: true }).innerText(), /测试模型 B/);
		await form.locator("summary").filter({ hasText: "高级模型参数" }).click();
		await form.getByRole("textbox", { name: "模型参数", exact: true }).fill("[]");
		await form.getByRole("button", { name: "保存模型配置", exact: true }).click();
		await form.getByRole("alert").waitFor();
		await form.getByRole("textbox", { name: "模型参数", exact: true }).fill("{}");
		await form.getByRole("button", { name: "保存模型配置", exact: true }).click();
		await form.getByText("已保存", { exact: true }).waitFor();
		assert.equal(
			(await page.evaluate(() => window.suiming?.invoke("models.show", {})))?.profiles.find(
				(item) => item.id === "main",
			)?.model,
			"second",
		);
		// 连按两下 Esc：第一下关模型选择浮层，第二下关设置。浮层在退出动画里仍占着层栈顶，
		// 第二下曾被这个正在关闭的浮层吃掉，设置框关不掉（整套跑时偶发，单跑看不出来）。
		await form.getByRole("combobox", { name: "模型", exact: true }).click();
		await page.getByRole("combobox", { name: "搜索模型", exact: true }).waitFor();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await page.getByRole("heading", { name: "设置", exact: true }).waitFor({ state: "hidden", timeout: 2000 });
		assert.equal(await input.inputValue(), "保留这段未发送的草稿");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("tab", { name: /提供商/ }).click();
		await page.getByRole("button", { name: "配置 示例提供商", exact: true }).click();
		await page.getByRole("button", { name: "删除本地凭据", exact: true }).click();
		await page.getByRole("button", { name: "保留", exact: true }).click();
		await page.getByRole("button", { name: "删除本地凭据", exact: true }).click();
		await page.getByRole("button", { name: "确认删除", exact: true }).click();
		await page.getByText("未配置凭据", { exact: true }).waitFor();
		// 关闭配置面板会取消等待中的登录；重开可重新发起。
		await page.getByRole("button", { name: "输入 API key", exact: true }).click();
		await secret.waitFor();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("tab", { name: /提供商/ }).click();
		await page.getByRole("button", { name: "添加提供商", exact: true }).click();
		await page.getByRole("button", { name: "配置 示例提供商", exact: true }).click();
		await page.getByRole("button", { name: "输入 API key", exact: true }).waitFor();
		await page.keyboard.press("Escape");
		const loginStatus = await app.evaluate(() => {
			const state = (
				globalThis as unknown as {
					modelSettingsTest: {
						sessions: string[];
						settings: { loginStatus(input: { sessionId: string }): { status: string } };
					};
				}
			).modelSettingsTest;
			return state.settings.loginStatus({ sessionId: state.sessions.at(-1) ?? "missing-session" }).status;
		});
		assert.equal(loginStatus, "cancelled");
		assert.equal(await input.inputValue(), "保留这段未发送的草稿");
		assert.deepEqual(errors, []);
	} catch (error) {
		await page.screenshot({ animations: "disabled", path: "/tmp/suiming-model-picker-failure.png" });
		console.error(await page.locator("body").innerText());
		throw error;
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
