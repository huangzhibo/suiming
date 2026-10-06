import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runTaskLoop } from "../src/harness/loop.js";
import { ModelGateway } from "../src/model/model-gateway.js";

async function fixture() {
	const provider = fauxProvider({ provider: "persistence-test" });
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const gateway = new ModelGateway(models, { profiles: { main: profile, reviewer: profile } });
	const model = await gateway.bind("main");
	const effects: string[] = [];
	const tools = ["first", "second"].map((name) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => {
			effects.push(name);
			return { content: [{ type: "text" as const, text: "done" }], details: {} };
		},
	}));
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("first", {}), fauxToolCall("second", {})]),
		fauxAssistantMessage("完成"),
	]);
	return {
		provider,
		effects,
		options: { model, tools, systemPrompt: "test", prompt: "执行", budget: { maxTurns: 3 } },
	};
}

test("请求前恢复点保存失败时不调用 provider、不执行工具", async () => {
	const { provider, effects, options } = await fixture();
	const failure = new Error("checkpoint write failed");
	await assert.rejects(
		runTaskLoop({
			...options,
			onTurnStart: () => {
				throw failure;
			},
		}),
		(error) => error === failure,
	);
	assert.equal(provider.state.callCount, 0);
	assert.deepEqual(effects, []);
});

test("用量持久确认失败时不执行该响应中的任何工具", async () => {
	const { provider, effects, options } = await fixture();
	const failure = new Error("usage write failed");
	await assert.rejects(
		runTaskLoop({
			...options,
			onModelCall: () => {
				throw failure;
			},
		}),
		(error) => error === failure,
	);
	assert.equal(provider.state.callCount, 1);
	assert.deepEqual(effects, []);
});

test("工具事件保存失败时停止同批次后续工具和下一次模型调用", async () => {
	const { provider, effects, options } = await fixture();
	const failure = new Error("event write failed");
	await assert.rejects(
		runTaskLoop({
			...options,
			onToolCall: () => {
				throw failure;
			},
		}),
		(error) => error === failure,
	);
	assert.equal(provider.state.callCount, 1);
	assert.deepEqual(effects, ["first"]);
});

test("读取 steering 失败必须停止，不能冒充没有作者指令而继续调用", async () => {
	const { provider, options } = await fixture();
	const failure = new Error("steering read failed");
	await assert.rejects(
		runTaskLoop({
			...options,
			steering: () => {
				throw failure;
			},
		}),
		(error) => error === failure,
	);
	assert.equal(provider.state.callCount, 0);
});

test("流中断这类瞬时失败在同一个 turn 里退避重发：失败的调用照记，它带出的工具不执行", async () => {
	// 2026-10-02 斗破抽取：一次 `terminated` 就结束了根 turn；DeepSeek 那次还丢了一个跑了 27 次调用的子任务。
	const { provider, effects, options } = await fixture();
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("second", {})], { stopReason: "error", errorMessage: "terminated" }),
		fauxAssistantMessage([fauxToolCall("first", {})]),
		fauxAssistantMessage("完成"),
	]);
	const calls: string[] = [];
	const outcome = await runTaskLoop({
		...options,
		budget: { maxTurns: 5 },
		transientRetry: { maxRetries: 3, baseDelayMs: 0 },
		onModelCall: (_usage, callId) => {
			calls.push(callId);
		},
	});
	assert.equal(outcome.stop, "model_stopped");
	assert.deepEqual(effects, ["first"]);
	assert.equal(new Set(calls).size, 3, "失败的那次也记账");
	assert.ok(!outcome.messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
});

test("不可重试的失败立即报错；瞬时失败重试用尽也如实报 model_call_failed", async () => {
	const unauthorized = await fixture();
	unauthorized.provider.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
	]);
	await assert.rejects(runTaskLoop({ ...unauthorized.options, transientRetry: { maxRetries: 3, baseDelayMs: 0 } }), {
		code: "model_call_failed",
	});
	assert.equal(unauthorized.provider.state.callCount, 1);

	const flaky = await fixture();
	flaky.provider.setResponses(
		Array.from({ length: 3 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })),
	);
	await assert.rejects(runTaskLoop({ ...flaky.options, transientRetry: { maxRetries: 2, baseDelayMs: 0 } }), {
		code: "model_call_failed",
		message: /terminated.*重试 2 次/u,
	});
	assert.equal(flaky.provider.state.callCount, 3);
});

test("退避等待中作者停下：立即以 run_interrupted 结束，不再重发", async () => {
	const { provider, options } = await fixture();
	provider.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })]);
	const stop = new AbortController();
	const started = performance.now();
	await assert.rejects(
		runTaskLoop({
			...options,
			signal: stop.signal,
			transientRetry: { maxRetries: 3, baseDelayMs: 60_000 },
			onModelCall: () => {
				// 落在退避等待里：响应已记账、重发还没开始
				setTimeout(() => stop.abort("作者停下"), 50);
			},
		}),
		{ code: "run_interrupted" },
	);
	assert.ok(performance.now() - started < 5_000);
	assert.equal(provider.state.callCount, 1);
});

test("同一次回复里相邻的可并行动作同时执行，结果按派出顺序交付；不可并行的仍一次一个", async () => {
	// 2026-10-02 斗破抽取：3 个读原文的子任务一次派出却串行跑了约 30 分钟，host 12 个并行 4–9 分钟。
	const { provider, options } = await fixture();
	const started = new Map<string, () => void>();
	const startedPromise = (name: string) => new Promise<void>((resolve) => started.set(name, resolve));
	const aStarted = startedPromise("a");
	const bStarted = startedPromise("b");
	const within = (promise: Promise<void>, label: string) =>
		Promise.race([
			promise,
			new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`${label} 没有同时开始`)), 1000)),
		]);
	const log: string[] = [];
	const parallelTool = (name: string, other: Promise<void>) => ({
		name,
		label: name,
		description: name,
		parallel: () => true,
		parameters: Type.Object({}),
		execute: async () => {
			started.get(name)?.();
			await within(other, name);
			log.push(`${name} 完成`);
			return { content: [{ type: "text" as const, text: `${name} 的结果` }], details: {} };
		},
	});
	const serial = {
		name: "serial",
		label: "serial",
		description: "serial",
		parameters: Type.Object({}),
		execute: async () => {
			log.push("serial 完成");
			return { content: [{ type: "text" as const, text: "serial 的结果" }], details: {} };
		},
	};
	provider.setResponses([
		fauxAssistantMessage([fauxToolCall("a", {}), fauxToolCall("b", {}), fauxToolCall("serial", {})]),
		fauxAssistantMessage("完成"),
	]);
	const outcome = await runTaskLoop({
		...options,
		tools: [parallelTool("a", bStarted), parallelTool("b", aStarted), serial],
	});
	assert.equal(outcome.stop, "model_stopped");
	assert.equal(log.at(-1), "serial 完成", "不可并行的动作等前面的并行组结束才执行");
	const results = outcome.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => (message.content[0] as { text: string }).text);
	assert.deepEqual(results, ["a 的结果", "b 的结果", "serial 的结果"], "按派出顺序交付");
});
