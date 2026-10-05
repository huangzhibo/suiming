import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	ArtifactError,
	type ExecutionStateEvent,
	LocalProjectService,
	LocalSessionController,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

async function fixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "suiming-local-session-controller-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	return root;
}

function gateway(provider: ReturnType<typeof fauxProvider>): ModelGateway {
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: {
			main: { provider: provider.provider.id, model: "agent-model" },
			reviewer: { provider: provider.provider.id, model: "reviewer-model" },
		},
	});
}

/** 收到请求后等 abort 才返回：模拟一个正在等模型的 turn。 */
function blockingProvider() {
	const provider = fauxProvider({
		provider: "suiming-local-controller-faux",
		models: [{ id: "agent-model" }, { id: "reviewer-model" }],
	});
	provider.setResponses([
		async (_context, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted === true) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			options?.signal?.throwIfAborted();
			return fauxAssistantMessage(fauxToolCall("write", { path: "intent/x.md", content: "x" }));
		},
	]);
	return provider;
}

/** 进入请求后不再返回、也不理 abort：模拟卡在外部调用里、收不了口的 turn。 */
function unstoppableProvider(entered: () => void) {
	const provider = fauxProvider({
		provider: "suiming-local-controller-stuck",
		models: [{ id: "agent-model" }, { id: "reviewer-model" }],
	});
	provider.setResponses([
		async () => {
			entered();
			return new Promise<never>(() => undefined);
		},
	]);
	return provider;
}

test("waitForIdle 有界：请求收不了口时按时返回，不把调用方挂死", async () => {
	const checkoutPath = await fixture();
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: "project-2" });
		let resolveEntered: () => void = () => undefined;
		const entered = new Promise<void>((resolve) => {
			resolveEntered = resolve;
		});
		const controller = new LocalSessionController({
			project,
			models: gateway(unstoppableProvider(() => resolveEntered())),
		});
		const sent = await controller.send({ commandId: "send-1", text: "执行到模型调用后卡在请求里" });
		// 必须等请求真正发出去才中断：在那之前 abort 会被循环自己接住，测不到收口边界。
		await entered;
		controller.interrupt(sent.sessionId);
		// 无界版本在这里永远不返回。有界版本按时交回控制权，并如实说没收口。
		assert.equal(await controller.waitForIdle({ timeoutMs: 50 }), "timeout");
		assert.deepEqual(controller.activeSessionIds(), [sent.sessionId]);
		assert.equal(project.loadExecutionState().sessions[0]?.status, "running");
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
});

test("一句话开一个 turn；同一作品同时只跑一个；interrupt 回 idle 且消息列表保留", async () => {
	const checkoutPath = await fixture();
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: "project-1" });
		const genesis = project.project().headRevisionId;
		const controller = new LocalSessionController({ project, models: gateway(blockingProvider()) });
		const events: ExecutionStateEvent[] = [];
		let resolveRunning: () => void = () => undefined;
		const running = new Promise<void>((resolve) => {
			resolveRunning = resolve;
		});
		const unsubscribe = controller.subscribe((event) => {
			events.push(event);
			if (event.entityType === "session" && event.snapshot.status === "running") resolveRunning();
		});
		controller.subscribe(() => {
			throw new Error("UI listener failure must not affect execution persistence");
		});

		const sent = await controller.send({ commandId: "send-1", text: "执行到模型调用后由作者停止" });
		assert.deepEqual(controller.activeSessionIds(), [sent.sessionId]);
		await assert.rejects(
			() => controller.send({ commandId: "send-2", text: "不得并发开第二个 session 的 turn" }),
			(error: unknown) => error instanceof ArtifactError && error.code === "session_running",
		);
		// 同一个 session 再说一句：排进 inbox，不另开 turn。
		const queued = await controller.send({ commandId: "send-3", text: "顺便改一下大纲", sessionId: sent.sessionId });
		assert.equal(queued.sequence, 2);
		await running;
		const interrupted = controller.interrupt(sent.sessionId);
		assert.equal(interrupted.status, "running");
		await controller.completion(sent.sessionId);

		const snapshot = project.loadExecutionState();
		assert.equal(snapshot.sessions[0]?.status, "idle");
		assert.equal(snapshot.sessions[0]?.lastFailure, undefined, "作者的停止不是故障");
		assert.equal(snapshot.sessions[0]?.lease, undefined);
		assert.equal(project.project().headRevisionId, genesis);
		assert.deepEqual(controller.activeSessionIds(), []);
		assert.deepEqual(
			project.readInbox(sent.sessionId).map((item) => item.text),
			["执行到模型调用后由作者停止", "顺便改一下大纲"],
			"消息列表原样保留，下一条 send 接着跑",
		);
		assert.ok(events.length > 0);
		assert.equal(new Set(events.map((event) => event.sequence)).size, events.length);
		const statuses = events.filter((event) => event.entityType === "session").map((event) => event.snapshot.status);
		assert.ok(statuses.includes("running"));
		assert.equal(statuses.at(-1), "idle");
		unsubscribe();
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
});
