import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { LocalProjectService, ModelGateway, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { type DesktopBridge, EventType, type SessionEvent, type SessionEventBody } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import { collectPageErrors, eventually, launchDesktop, waitForSessionIdle } from "./launch.js";

declare const window: { suiming: DesktopBridge };
declare function requestAnimationFrame(callback: () => void): number;
interface Probe {
	inputs: number[];
	delays: number[];
	timer: ReturnType<typeof setInterval>;
}
interface Control {
	disconnected: boolean;
	failedAttaches: number;
	calls(): number;
}

/** 合成规模历史只用于 renderer 压力；本轮读取、流式输出、停止和补读都经真实 Harness / SQLite / IPC。 */
async function seedHistory(root: string): Promise<void> {
	const project = await LocalProjectService.init({ checkoutPath: root });
	try {
		const provider = fauxProvider({ provider: "desktop-test", api: "desktop-test-api" });
		const models = createModels();
		models.setProvider(provider.provider);
		const profile = { provider: provider.getModel().provider, model: provider.getModel().id };
		const gateway = new ModelGateway(models, { profiles: { main: profile, reviewer: profile } });
		const model = (await gateway.bind("main")).snapshot;
		project.createExecutionState().createSession({
			commandId: "seed",
			id: "streaming-history",
			projectId: project.projectId,
			model,
			baseRevisionId: await project.refreshHead(),
		});
		const events: SessionEvent[] = [];
		const add = (event: SessionEventBody) =>
			events.push({
				sessionId: "streaming-history",
				id: `seed-${events.length}`,
				sequence: events.length + 1,
				at: new Date().toISOString(),
				event,
			});
		add({ type: EventType.RUN_STARTED, threadId: "streaming-history", runId: "seed" });
		for (let i = 0; i < 120; i++) {
			for (const role of ["user", "assistant"] as const) {
				const id = `history-${role}-${i}`;
				add({ type: EventType.TEXT_MESSAGE_START, messageId: id, role });
				add({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: id,
					delta:
						role === "user"
							? `第 ${i} 次讨论：这个人物为何做出这样的选择？`
							: `第 ${i} 次分析\n\n${"人物的选择必须付出代价，前面的铺垫也应在此时显出作用。".repeat(30)}\n\n- 保留人物动机。\n- 核对前后情节。`,
				});
				add({ type: EventType.TEXT_MESSAGE_END, messageId: id });
			}
			for (let a = 0; a < 11; a++)
				add({
					type: EventType.ACTIVITY_SNAPSHOT,
					messageId: `history-action-${i}-${a}`,
					activityType: "suiming.action",
					content: { label: "read", status: "completed", target: "text/beat-0001.md" },
				});
		}
		add({ type: EventType.RUN_FINISHED, threadId: "streaming-history", runId: "seed" });
		project.appendSessionEvents(events);
	} finally {
		project.close();
	}
}

for (const layout of ["sidebar", "expanded", "narrow"] as const)
	test(`长对话持续流式输出（${layout}）：展开动作时输入、停止、断线补读与重载不重复执行`, {
		timeout: 120000,
	}, async () => {
		const directory = await mkdtemp(join(tmpdir(), "suiming-streaming-"));
		const root = join(directory, "work");
		await mkdir(root);
		await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
		await seedHistory(root);
		const app = await launchDesktop({ directory, project: root, flags: ["--streaming-test"] });
		const page = await app.firstWindow();
		page.setDefaultTimeout(15000);
		const errors = collectPageErrors(page);
		const input = page.getByRole("textbox", { name: "输入消息", exact: true });
		const metrics: Record<string, unknown> = {};
		try {
			await page.locator('[data-message-id="history-assistant-119"]').waitFor();
			assert.equal(await page.locator(".message").count(), 240);
			if (layout === "expanded") await page.getByRole("button", { name: "展开为主工作面", exact: true }).click();
			if (layout === "narrow") {
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 740));
				await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 960);
				await page.evaluate(
					() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
				);
				if (!(await input.isVisible())) await page.getByRole("button", { name: "展开右栏", exact: true }).click();
			}
			await input.fill("继续检查人物动机");
			await input.press("Meta+Enter");
			const flowing = page.locator(".message.assistant").filter({ hasText: "流式片段 0：" });
			await flowing.waitFor();
			const streamStarted = performance.now();
			// 主工作面多跑到 1.2 万字再操作，覆盖当前回复也逐渐变长的情况，而不只测历史很长。
			if (layout === "expanded")
				await eventually(async () => (await flowing.innerText()).length >= 12000, "持续输出达到 1.2 万字", 60000);
			await page.evaluate(() => {
				let last = performance.now();
				const probe: Probe = {
					inputs: [],
					delays: [],
					timer: setInterval(() => {
						const now = performance.now();
						probe.delays.push(Math.max(0, now - last - 50));
						last = now;
					}, 50),
				};
				Object.assign(globalThis, { streamingProbe: probe });
			});
			await input.evaluate((element) =>
				element.addEventListener("beforeinput", () => {
					const start = performance.now();
					requestAnimationFrame(() =>
						(globalThis as unknown as { streamingProbe: Probe }).streamingProbe.inputs.push(
							performance.now() - start,
						),
					);
				}),
			);
			// 向上滚动后打开最后一个真实动作，流入新段落不能抢回阅读位置。
			const viewport = page.locator("[data-conversation-viewport]");
			await viewport.hover();
			await page.mouse.wheel(0, -500);
			const action = page.locator(".activity[data-action-id]").last();
			const started = performance.now();
			await action.locator("summary").click();
			await action.locator(".action-detail").getByText("结果", { exact: true }).waitFor();
			metrics.actionOpenMs = performance.now() - started;
			const readingTop = await viewport.evaluate((e) => e.scrollTop);
			await input.click();
			const before = (await flowing.innerText()).length;
			const typing = performance.now();
			await input.pressSequentially("keep this draft while the story is streaming", { delay: 30 });
			metrics.typingMs = performance.now() - typing;
			assert.equal(await input.inputValue(), "keep this draft while the story is streaming");
			assert.equal(await input.evaluate((e) => e.ownerDocument.activeElement === e), true);
			await eventually(async () => (await flowing.innerText()).length > before, "输入期间输出仍在增长");
			assert.equal(await action.getAttribute("open"), "", "新片段不会收起动作");
			assert.equal(await viewport.evaluate((e) => e.scrollWidth > e.clientWidth), false, "展开动作不横向溢出");
			assert.ok(
				Math.abs((await viewport.evaluate((e) => e.scrollTop)) - readingTop) < 2,
				"输入和新片段不抢走历史阅读位置",
			);
			await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
			// 主进程保持运行，只有 attach 读失败。断线时还可以输入，恢复走同一个序号游标。
			await app.evaluate(() => {
				(globalThis as unknown as { streamingTest: Control }).streamingTest.disconnected = true;
			});
			await page.getByText("对话连接暂时中断，正在重新连接；Agent 的进度不会丢。", { exact: true }).waitFor();
			await input.pressSequentially(" after disconnect", { delay: 30 });
			const reconnect = performance.now();
			await app.evaluate(() => {
				(globalThis as unknown as { streamingTest: Control }).streamingTest.disconnected = false;
			});
			await page
				.getByText("对话连接暂时中断，正在重新连接；Agent 的进度不会丢。", { exact: true })
				.waitFor({ state: "hidden" });
			metrics.reconnectMs = performance.now() - reconnect;
			assert.equal(await input.evaluate((e) => e.ownerDocument.activeElement === e), true);
			assert.equal(await input.inputValue(), "keep this draft while the story is streaming after disconnect");
			const probe = await page.evaluate(() => {
				const probe = (globalThis as unknown as { streamingProbe: Probe }).streamingProbe;
				clearInterval(probe.timer);
				return { inputs: probe.inputs, delays: probe.delays };
			});
			assert.ok(probe.inputs.length >= 60, "确实测到逐字输入");
			assert.ok(Math.max(...probe.inputs) < 500, "输入到下一帧不应长时间阻塞");
			metrics.inputToFrameMs = probe.inputs;
			metrics.eventLoopDelayMs = probe.delays;
			const reload = performance.now();
			await page.reload();
			await flowing.waitFor();
			metrics.reloadMs = performance.now() - reload;
			assert.equal(await input.inputValue(), "keep this draft while the story is streaming after disconnect");
			assert.equal(await page.locator(".message.user").count(), 121);
			assert.equal(await page.locator(".message.assistant").count(), 121);
			const control = await app.evaluate(() => {
				const c = (globalThis as unknown as { streamingTest: Control }).streamingTest;
				return { failedAttaches: c.failedAttaches, calls: c.calls() };
			});
			assert.ok(control.failedAttaches > 0);
			assert.equal(control.calls, 2, "断线与重载没有重发模型请求");
			if (layout === "narrow") {
				await app.evaluate(() => {
					(globalThis as unknown as { streamingTest: Control }).streamingTest.disconnected = true;
				});
				await page.getByText("对话连接暂时中断，正在重新连接；Agent 的进度不会丢。", { exact: true }).waitFor();
			}
			metrics.streamingDurationMs = performance.now() - streamStarted;
			const stop = performance.now();
			await page.getByRole("button", { name: "停止", exact: true }).click();
			await waitForSessionIdle(page, "streaming-history");
			metrics.stopIdleMs = performance.now() - stop;
			assert.ok((metrics.stopIdleMs as number) < 3000, "包括断线时，停止命令也应及时返回 idle");
			if (layout === "narrow")
				await app.evaluate(() => {
					(globalThis as unknown as { streamingTest: Control }).streamingTest.disconnected = false;
				});
			await page
				.locator("[data-turn-summary]")
				.filter({ hasText: /^已停止/u })
				.waitFor();
			metrics.stopMs = performance.now() - stop;
			// 停止后读取权威事件快照，与 UI 文本逐字核对，发现重复片段或丢尾部。
			const snapshot = await page.evaluate(() =>
				window.suiming.invoke("session.attach", { sessionId: "streaming-history" }),
			);
			const messages = snapshot.snapshot?.find((event) => event.type === "MESSAGES_SNAPSHOT");
			const expected = messages?.messages.find(
				(message) => typeof message.content === "string" && message.content.startsWith("流式片段 0："),
			);
			assert.ok(expected && typeof expected.content === "string");
			await eventually(
				async () =>
					(await flowing.locator(".msg-text").innerText()).replace(/\s/gu, "") ===
					(expected.content as string).replace(/\s/gu, ""),
				"停止后的流式内容与持久快照逐字一致",
			);
			metrics.streamedCharacters = expected.content.length;
			assert.equal(
				await input.inputValue(),
				"keep this draft while the story is streaming after disconnect",
				"停止没有清空草稿",
			);
			if (process.env.SUIMING_CAPTURE_DIR) {
				await mkdir(process.env.SUIMING_CAPTURE_DIR, { recursive: true });
				await page.screenshot({ path: join(process.env.SUIMING_CAPTURE_DIR, `streaming-${layout}-stopped.png`) });
				await action.locator("summary").click();
				await action.locator(".action-detail").getByText("结果", { exact: true }).waitFor();
				await action.scrollIntoViewIfNeeded();
				await page.screenshot({ path: join(process.env.SUIMING_CAPTURE_DIR, `streaming-${layout}-action.png`) });
				await writeFile(
					join(
						process.env.SUIMING_CAPTURE_DIR,
						layout === "sidebar" ? "streaming-metrics.json" : `streaming-${layout}-metrics.json`,
					),
					`${JSON.stringify(metrics, null, 2)}\n`,
				);
			}
			const { inputToFrameMs: _inputs, eventLoopDelayMs: _delays, ...operations } = metrics;
			console.log(
				`streaming metrics (${layout})`,
				JSON.stringify({
					...operations,
					inputP95Ms: [...probe.inputs].sort((a, b) => a - b)[Math.ceil(probe.inputs.length * 0.95) - 1],
					inputMaxMs: Math.max(...probe.inputs),
					eventLoopDelayMaxMs: Math.max(...probe.delays),
				}),
			);
			// 导出拿点击时的最新消息，而不是最初注册导出入口时的历史。
			const exportPath = join(directory, "conversation.md");
			await app.evaluate(({ dialog }, path) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
			}, exportPath);
			await page.getByRole("button", { name: "对话菜单", exact: true }).click();
			await page.getByRole("menuitem", { name: "导出对话…", exact: true }).click();
			await page.getByText("对话已导出", { exact: true }).waitFor();
			const exported = await readFile(exportPath, "utf8");
			assert.ok(exported.includes(expected.content));
			assert.ok(exported.includes("第 119 次分析"));
			await input.fill("继续");
			await input.press("Meta+Enter");
			await page.locator(".message.assistant").filter({ hasText: "停止之后可以继续" }).waitFor();
			await waitForSessionIdle(page, "streaming-history", 2);
			assert.equal(
				await app.evaluate(() => (globalThis as unknown as { streamingTest: Control }).streamingTest.calls()),
				3,
				"继续只发起一次新请求",
			);
			assert.deepEqual(errors, []);
		} catch (error) {
			await page.screenshot({ path: "/tmp/suiming-streaming-failure.png" });
			console.error(
				JSON.stringify(metrics),
				JSON.stringify(await page.evaluate(() => window.suiming.invoke("session.list", {}))),
				(await page.locator("body").innerText()).slice(-700),
			);
			throw error;
		} finally {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
