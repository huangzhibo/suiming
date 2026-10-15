import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { OAUTH_TEST_PROVIDER, oauthFixture } from "../../../packages/runtime/test/oauth-fixture.js";
import { oauthServer } from "../../../packages/runtime/test/oauth-server.js";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, isolatedEnv, launchDesktop, waitForSessionIdle } from "./launch.js";

declare const window: { suiming?: DesktopBridge };

test("桌面与独立 CLI 并发刷新；授权失效后候选和对话保留，设置重新登录沿原会话继续", { timeout: 90000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "suiming-oauth-desktop-"));
	const root = join(directory, "work");
	const cliRoot = join(directory, "cli-work");
	for (const path of [root, cliRoot]) {
		await mkdir(path);
		await materializeOpenStoryDirectorySnapshot(path, sampleWorkFiles());
		(await LocalProjectService.init({ checkoutPath: path })).close();
	}
	const server = await oauthServer();
	const authPath = join(directory, "auth.json");
	const fixture = oauthFixture(authPath, server.endpoint);
	await fixture.credentials.modify(OAUTH_TEST_PROVIDER, async () => ({ ...server.credential(), expires: 0 }));
	const gate = Promise.withResolvers<void>();
	server.state.refreshGate = gate.promise;
	const app = await launchDesktop({
		directory,
		project: root,
		flags: ["--oauth-recovery-test"],
		env: { SUIMING_TEST_OAUTH_ENDPOINT: server.endpoint },
	});
	const page = await app.firstWindow();
	page.setDefaultTimeout(15000);
	const errors = collectPageErrors(page);
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const input = page.getByRole("textbox", { name: "输入消息" });
		await input.fill("桌面并发认证");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await server.state.refreshEntered.promise;
		child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				resolve("apps/cli/test/oauth-process.ts"),
				authPath,
				server.endpoint,
				"--project",
				cliRoot,
				"session",
				"send",
				"CLI 并发认证",
			],
			{ env: isolatedEnv(directory), stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);
		let cliOutput = "";
		child.stdout?.on("data", (chunk) => {
			cliOutput += chunk;
		});
		const exit = once(child, "exit");
		await once(child, "message");
		gate.resolve();
		assert.equal((await exit)[0], 0, cliOutput);
		assert.equal(JSON.parse(cliOutput).ok, true);
		await page.locator(".message.assistant").filter({ hasText: "认证后继续成功。" }).waitFor();
		assert.equal(server.state.refreshes, 1, "桌面与 CLI 只兑换一次令牌");
		const sessions = await page.evaluate(() => window.suiming?.invoke("session.list", {}));
		const id = sessions?.sessions[0]?.id;
		assert.ok(id);
		await waitForSessionIdle(page, id);
		const history = await page.evaluate(async () => (await window.suiming?.invoke("workspace.show", {}))?.revisions);
		const candidatePath = join(root, "intent/认证验收.md");
		let step = 0;
		server.state.respond = async () => {
			step++;
			if (step === 1) {
				await fixture.credentials.modify(OAUTH_TEST_PROVIDER, async () => ({ ...server.credential(), expires: 0 }));
				server.state.failure = "invalid_grant: refresh token revoked";
				return fauxAssistantMessage(
					fauxToolCall("write", { path: "intent/认证验收.md", content: "保持原候选，不要自动提交。" }),
				);
			}
			return fauxAssistantMessage("重新登录后已沿原对话继续，候选保留。 ");
		};
		await input.fill("先写候选，再继续核对");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await waitForSessionIdle(page, id, 2);
		await page.locator("summary").filter({ hasText: "查看原因" }).click();
		await page
			.locator("details[open]")
			.getByText(/授权刷新失败/)
			.waitFor();
		assert.match(await page.locator("body").innerText(), /重新登录/);
		assert.equal(server.state.refreshes, 2, "失效授权不反复重试");
		assert.equal(await readFile(candidatePath, "utf8"), "保持原候选，不要自动提交。");
		assert.deepEqual(
			await page.evaluate(async () => (await window.suiming?.invoke("workspace.show", {}))?.revisions),
			history,
		);
		await page.reload();
		await input.waitFor();
		assert.equal((await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions[0]?.id, id);
		await input.fill("这段草稿在登录期间也要保留");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("tab", { name: "提供商", exact: true }).click();
		await page.getByRole("button", { name: "配置 隔离认证", exact: true }).click();
		await page.getByRole("button", { name: "登录 测试登录", exact: true }).click();
		await page.getByRole("textbox", { name: "输入隔离授权码", exact: true }).fill("isolated-code");
		await page.getByRole("button", { name: "提交", exact: true }).click();
		await page.getByText("账号登录", { exact: true }).waitFor();
		assert.equal(server.state.logins, 1);
		server.state.failure = "";
		await page.getByRole("button", { name: "关闭", exact: true }).click();
		await page.keyboard.press("Escape");
		assert.equal(await input.inputValue(), "这段草稿在登录期间也要保留");
		await input.fill("重新登录好了，继续");
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await waitForSessionIdle(page, id, 3);
		await page.locator(".message.assistant").filter({ hasText: "重新登录后已沿原对话继续" }).waitFor();
		assert.match(JSON.stringify(server.state.messages.at(-1)), /先写候选，再继续核对/);
		assert.match(JSON.stringify(server.state.messages.at(-1)), /桌面并发认证/);
		assert.equal(await readFile(candidatePath, "utf8"), "保持原候选，不要自动提交。");
		assert.deepEqual(
			await page.evaluate(async () => (await window.suiming?.invoke("workspace.show", {}))?.revisions),
			history,
		);
		assert.equal((await page.evaluate(() => window.suiming?.invoke("session.list", {})))?.sessions.length, 1);
		assert.equal(server.state.refreshes, 2);
		assert.deepEqual(
			await page.evaluate(() => window.suiming?.invoke("project.diff", {})),
			[{ path: "intent/认证验收.md", kind: "added" }],
			"除指定候选外，作品文件没有被认证恢复改写",
		);
		assert.deepEqual(errors, []);
		if (process.env.SUIMING_CAPTURE_DIR) {
			await mkdir(process.env.SUIMING_CAPTURE_DIR, { recursive: true });
			await page.screenshot({ path: join(process.env.SUIMING_CAPTURE_DIR, "oauth-recovered.png") });
		}
	} catch (error) {
		await page.screenshot({ path: join(directory, "failure.png") });
		console.error(directory, await page.locator("body").innerText());
		throw error;
	} finally {
		gate.resolve();
		child?.kill();
		await app.close();
		await server.close();
		await rm(directory, { recursive: true, force: true });
	}
});
