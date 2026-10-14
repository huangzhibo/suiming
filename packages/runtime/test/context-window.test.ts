import assert from "node:assert/strict";
import test from "node:test";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import { type LoopCheckpoint, runTaskLoop } from "../src/harness/loop.js";
import type { HarnessTool } from "../src/harness/tool.js";
import { ModelGateway } from "../src/model/model-gateway.js";

/**
 * 接近窗口与超限恢复共用摘要路径；原消息保留，近期原话和工具调用配对不能丢。
 * 这里的 faux provider 按请求大小拒绝超限请求，和真实 provider 一样。
 */

/**
 * 与 faux provider 估算 input tokens 的口径一致（它的 serializeContext：各消息的文本拼起来，字符数 / 4），
 * harness 用返回的 usage 校准自己的估计，这里的「provider 上限」也得按同一口径算。pi-ai 0.99 起 faux 拿到的是
 * 折好的 transcript：系统提示与工具声明在开头那条 system message 里，只序列化消息。
 */
/** faux 拿到的是折好的 transcript，不再是带 systemPrompt / tools 的 Context。 */
type Transcript = { messages: readonly Message[] };

function tokensOf(context: Transcript): number {
	const text = (message: Message): string => {
		if (message.role === "system")
			return [
				getSystemMessageText(message),
				...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
				...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
			]
				.filter((part) => part.length > 0)
				.join("\n");
		if (message.role === "user")
			return typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		if (message.role === "assistant")
			return message.content
				.map((part) =>
					part.type === "text"
						? part.text
						: part.type === "thinking"
							? part.thinking
							: `${part.name}:${JSON.stringify(part.arguments)}`,
				)
				.join("\n");
		return [message.toolName, ...message.content.map((part) => (part.type === "text" ? part.text : ""))].join("\n");
	};
	return Math.ceil(context.messages.map((message) => `${message.role}:${text(message)}`).join("\n\n").length / 4);
}

function overflow(tokens: number, limit: number) {
	return fauxAssistantMessage([], {
		stopReason: "error",
		errorMessage: `prompt is too long: ${tokens} tokens > ${limit} maximum`,
	});
}

async function fixture(contextWindow: number) {
	const provider = fauxProvider({
		provider: "context-window",
		models: [{ id: "small", contextWindow, maxTokens: 1000, reasoning: false }],
	});
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: "small" };
	const model = await new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }).bind("main");
	return { provider, model };
}

/** 一个读取工具：每次返回一大段不同的正文。 */
function bigTool(size: number): HarnessTool {
	let count = 0;
	return {
		name: "big",
		description: "读一大段正文",
		parameters: Type.Object({}, { additionalProperties: false }),
		rereadable: true,
		async execute() {
			count += 1;
			return { content: [{ type: "text" as const, text: `第${count}段：${"黄盖受刑".repeat(size / 4)}` }] };
		},
	};
}

/** 校准前的估计不超过窗口、校准后又高于压缩线的长度；faux 按字符数 / 4 计，harness 起初按字节数 / 3 估。 */

function lastToolResults(context: Transcript): string[] {
	return context.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
}

test("请求带上 loop 的 id 作 sessionId：按会话做 prompt cache 的 provider 能把同一会话的请求路由到一起", async () => {
	const { provider, model } = await fixture(1_000_000);
	const sessionIds: (string | undefined)[] = [];
	provider.setResponses([
		async (_context: Transcript, options?: { sessionId?: string }) => {
			sessionIds.push(options?.sessionId);
			return fauxAssistantMessage(fauxToolCall("big", {}));
		},
		async (_context: Transcript, options?: { sessionId?: string }) => {
			sessionIds.push(options?.sessionId);
			return fauxAssistantMessage("读完了");
		},
	]);
	await runTaskLoop({
		model,
		loopId: "session-cache",
		systemPrompt: "测试",
		prompt: "读一次",
		tools: [bigTool(40)],
		budget: { maxTurns: 5 },
	});
	assert.deepEqual(sessionIds, ["session-cache", "session-cache"]);
});

/** 折叠测试用的读取结果大约 12 KB，过 FOLD_BYTES（10 KB）；窗口给得很大，清理与压缩都不会触发。 */
const FOLD_SIZE = 4000;

function toolTexts(context: Transcript): string[] {
	return lastToolResults(context);
}

test("上一轮停下之后作者再说一句：之前的大读取结果折成头尾，这一轮读的照常全文；干活中途的插话不折，原消息不改", async () => {
	const { provider, model } = await fixture(1_000_000);
	const inbox: { sequence: number; text: string }[] = [];
	const seen: Transcript[] = [];
	let checkpoint: LoopCheckpoint | undefined;
	const big = bigTool(FOLD_SIZE);
	const run = (responses: ((context: Transcript) => Promise<ReturnType<typeof fauxAssistantMessage>>)[]) => {
		provider.setResponses(
			responses.map((respond) => async (context: Transcript) => {
				seen.push(context);
				return respond(context);
			}),
		);
		return runTaskLoop({
			model,
			systemPrompt: "测试",
			...(checkpoint === undefined ? { prompt: "先读一段" } : { checkpoint }),
			tools: [big],
			budget: { maxTurns: 20 },
			steering: () => inbox,
			saveCheckpoint: async (next) => {
				checkpoint = structuredClone(next);
			},
		});
	};
	await run([
		async () => {
			// 模型还在干活时作者插了一句：不是边界，刚读的结果下一次请求照常全文。
			inbox.push({ sequence: 1, text: "读的时候留意黄盖" });
			return fauxAssistantMessage(fauxToolCall("big", {}));
		},
		async (context) => {
			assert.match(toolTexts(context)[0] ?? "", /^第1段：(黄盖受刑)+$/u, "插话之后第一段仍是全文");
			return fauxAssistantMessage("第一段读完了");
		},
	]);
	inbox.push({ sequence: 2, text: "再读一段" });
	await run([
		async (context) => {
			const [first] = toolTexts(context);
			assert.match(first ?? "", /^\[已折叠：上一个边界（新一轮或提交）之前的 big \{\}，原文 \d+ 字/u);
			assert.match(first ?? "", /\n第1段：黄盖受刑/u, "留着开头");
			assert.ok((first?.length ?? 0) < 1000, "只剩头尾");
			return fauxAssistantMessage(fauxToolCall("big", {}));
		},
		async (context) => {
			const [first, second] = toolTexts(context);
			assert.match(first ?? "", /^\[已折叠/u, "上一轮的仍然折着，前缀不变");
			assert.match(second ?? "", /^第2段：(黄盖受刑)+$/u, "边界之后读的照常全文");
			return fauxAssistantMessage("第二段也读完了");
		},
	]);
	assert.equal(seen.length, 4);
	const stored = (checkpoint?.messages ?? []).filter((message) => message.role === "toolResult");
	assert.equal(stored.length, 2);
	assert.ok(
		stored.every((message) =>
			/^第\d段：(黄盖受刑)+$/u.test(message.content.map((part) => (part.type === "text" ? part.text : "")).join("")),
		),
		"checkpoint 里的原消息一字不改",
	);
});

test("提交产生新版本是边界：之前的大读取结果折成头尾；写入这类非读取工具的大结果不折，小结果不折", async () => {
	const { provider, model } = await fixture(1_000_000);
	const seen: Transcript[] = [];
	const respond = [
		fauxAssistantMessage([fauxToolCall("big", {}), fauxToolCall("delegate", {}), fauxToolCall("small", {})]),
		fauxAssistantMessage(fauxToolCall("commit", {})),
		async (context: Transcript) => {
			seen.push(context);
			return fauxAssistantMessage("提交完了");
		},
	];
	provider.setResponses(respond);
	const tool = (name: string, rereadable: boolean, text: string, boundary = false): HarnessTool => ({
		name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		rereadable,
		execute: async () => ({
			content: [{ type: "text" as const, text }],
			...(boundary ? { contextBoundary: true } : {}),
		}),
	});
	await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "读、委派、提交",
		tools: [
			bigTool(FOLD_SIZE),
			tool("delegate", false, `子任务交付：${"阚泽献书".repeat(FOLD_SIZE / 4)}`),
			tool("small", true, "小结果"),
			tool("commit", false, "已提交 r2", true),
		],
		budget: { maxTurns: 10 },
	});
	const [big, delegated, small, committed] = toolTexts(seen[0] as Transcript);
	assert.match(big ?? "", /^\[已折叠：上一个边界（新一轮或提交）之前的 big/u);
	assert.match(delegated ?? "", /^子任务交付：(阚泽献书)+$/u, "非读取工具重调不得，不折");
	assert.equal(small, "小结果");
	assert.equal(committed, "已提交 r2");
});

test("压缩和别的工具在同一次回复里：同一批读到的结果压缩后照常发，之前的才由摘要代表", async () => {
	const { provider, model } = await fixture(1_000_000);
	const seen: Transcript[] = [];
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("big", {})),
		fauxAssistantMessage([fauxToolCall("compact_context", { summary: "读过第一段。" }), fauxToolCall("big", {})]),
		async (context: Transcript) => {
			seen.push(context);
			return fauxAssistantMessage("接着说");
		},
	]);
	const { compactContextTool } = await import("../src/harness/tools.js");
	await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "读两段",
		tools: [bigTool(40), compactContextTool()],
		budget: { maxTurns: 10 },
	});
	const texts = toolTexts(seen[0] as Transcript);
	assert.ok(!texts.some((text) => text.startsWith("第1段")), "压缩之前的结果由摘要代表");
	assert.ok(
		texts.some((text) => text.startsWith("第2段")),
		"同一批读到的第二段照常发",
	);
	assert.match(JSON.stringify(seen[0]?.messages), /读过第一段。/u, "摘要在写它的那次回复里");
});

async function history(
	model: Awaited<ReturnType<typeof fixture>>["model"],
	provider: Awaited<ReturnType<typeof fixture>>["provider"],
) {
	let checkpoint: LoopCheckpoint | undefined;
	provider.setResponses([fauxAssistantMessage("开场已确认")]);
	await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "作品开场",
		tools: [],
		budget: { maxTurns: 1 },
		saveCheckpoint: async (next) => {
			checkpoint = structuredClone(next);
		},
	});
	assert.ok(checkpoint);
	checkpoint.phase = "ready";
	delete checkpoint.stop;
	checkpoint.turns = 0;
	checkpoint.calls = [];
	for (let n = 0; n < 16; n++)
		checkpoint.messages.push(
			{ role: "user", content: `旧要求 ${n}：${"情节与人物的历史讨论。".repeat(80)}`, timestamp: n },
			fauxAssistantMessage("已记录，尚未写入作品。"),
		);
	checkpoint.messages.push({
		role: "user",
		content: "改口：取消悲剧结局，保留真实代价。继续尚未提交的第二节。",
		timestamp: 100,
	});
	return checkpoint;
}
function isSummary(context: Transcript) {
	return JSON.stringify(context.messages[0]).includes("你只负责生成简洁的执行摘要");
}

test("缩小窗口：分批整理旧作者消息，保留最新改口、刷新作品开场，原记录不变", async () => {
	const { provider, model } = await fixture(8000);
	const checkpoint = await history(model, provider);
	const before = structuredClone(checkpoint.messages);
	const seen: Transcript[] = [];
	let saved = checkpoint;
	provider.setResponses(
		Array.from({ length: 20 }, () => async (context: Transcript) => {
			seen.push(context);
			return fauxAssistantMessage(
				isSummary(context) ? "当前要求：取消悲剧结局，保留代价；第二节尚未提交。" : "接着写第二节。",
			);
		}),
	);
	await runTaskLoop({
		model,
		systemPrompt: "测试",
		checkpoint,
		tools: [],
		budget: { maxTurns: 20 },
		refreshOpening: async () => "当前作品 r3",
		saveCheckpoint: async (next) => {
			saved = structuredClone(next);
		},
	});
	assert.ok(seen.some(isSummary));
	assert.ok(
		seen.filter(isSummary).every((context) => JSON.stringify(context.messages).includes("取消悲剧结局")),
		"每批摘要都看得到最新改口，避免把旧要求写成仍然有效",
	);
	const final = seen.at(-1);
	assert.ok(final);
	assert.match(JSON.stringify(final.messages), /取消悲剧结局/u);
	assert.match(JSON.stringify(final.messages), /当前作品 r3/u);
	assert.ok(final.messages.filter((m) => m.role === "user").length < 10, "旧作者原话不再无限堆积");
	assert.deepEqual(saved.messages.slice(0, before.length), before);
	assert.equal(saved.usage.calls, seen.length + 1, "摘要也计费用量");
	assert.ok(saved.calls.some((c) => c.purpose === "compaction"));
});

test("provider 超限后走摘要再继续，第二次超限停止，不盲目重发", async () => {
	const { provider, model } = await fixture(1000000);
	const checkpoint = await history(model, provider);
	let ordinary = 0,
		summaries = 0;
	provider.setResponses(
		Array.from({ length: 10 }, () => async (context: Transcript) => {
			if (isSummary(context)) {
				summaries++;
				return fauxAssistantMessage("已讨论旧要求，按最新改口继续。");
			}
			ordinary++;
			return overflow(tokensOf(context), 100);
		}),
	);
	await assert.rejects(runTaskLoop({ model, systemPrompt: "测试", checkpoint, tools: [], budget: { maxTurns: 10 } }), {
		code: "context_overflow",
	});
	assert.equal(summaries, 1);
	assert.equal(ordinary, 2);
});

test("摘要流中断后续同一历史，未知调用保留，摘要正文不作为助手答复发布", async () => {
	const { provider, model } = await fixture(8000);
	const checkpoint = await history(model, provider);
	let saved = checkpoint;
	let messages = 0;
	provider.setResponses([
		async () => {
			throw new Error("summary stream interrupted");
		},
	]);
	const options = {
		model,
		systemPrompt: "测试",
		tools: [],
		budget: { maxTurns: 20 },
		saveCheckpoint: async (next: LoopCheckpoint) => {
			saved = structuredClone(next);
		},
		onMessage: () => {
			messages++;
		},
		transientRetry: { maxRetries: 0, baseDelayMs: 0 },
	};
	await assert.rejects(runTaskLoop({ ...options, checkpoint }));
	assert.deepEqual(saved.messages, checkpoint.messages);
	assert.ok(saved.compacting);
	provider.setResponses(
		Array.from(
			{ length: 20 },
			() => async (context: Transcript) =>
				fauxAssistantMessage(isSummary(context) ? "第二节未提交，按最新要求继续。" : "继续完成。"),
		),
	);
	await runTaskLoop({ ...options, checkpoint: saved });
	assert.equal(messages, 1);
	assert.ok(saved.calls.length > 1);
	assert.equal(saved.phase, "settled");
});

test("截断摘要不替代历史，继续后可重新生成", async () => {
	const { provider, model } = await fixture(8000);
	const checkpoint = await history(model, provider);
	let saved = checkpoint;
	provider.setResponses([fauxAssistantMessage("未完整的摘要", { stopReason: "length" })]);
	const options = {
		model,
		systemPrompt: "测试",
		tools: [],
		budget: { maxTurns: 20 },
		saveCheckpoint: async (next: LoopCheckpoint) => {
			saved = structuredClone(next);
		},
	};
	await assert.rejects(runTaskLoop({ ...options, checkpoint }), { code: "model_output_truncated" });
	assert.deepEqual(saved.messages, checkpoint.messages);
	assert.equal(saved.reduction, undefined);
	provider.setResponses(
		Array.from(
			{ length: 20 },
			() => async (context: Transcript) =>
				fauxAssistantMessage(isSummary(context) ? "第二节未提交，按最新要求继续。" : "完成。"),
		),
	);
	await runTaskLoop({ ...options, checkpoint: saved });
	assert.equal(saved.phase, "settled");
});

test("开场独自超过窗口：不发送请求，也不空转摘要", async () => {
	const { provider, model } = await fixture(1000);
	let calls = 0;
	provider.setResponses([
		async () => {
			calls++;
			return fauxAssistantMessage("不应请求");
		},
	]);
	await assert.rejects(
		runTaskLoop({ model, systemPrompt: "测试", prompt: "长正文".repeat(2000), tools: [], budget: { maxTurns: 20 } }),
		{ code: "context_overflow" },
	);
	assert.equal(calls, 0);
});

test("摘要已落盘后进程退出：恢复直接应用已有结果，调用与用量不重复", async () => {
	const { provider, model } = await fixture(8000);
	const checkpoint = await history(model, provider);
	let saved = checkpoint;
	let crashed = false;
	let count = 0;
	provider.setResponses(
		Array.from({ length: 20 }, () => async (context: Transcript) => {
			count++;
			return fauxAssistantMessage(isSummary(context) ? "保留代价，第二节未提交。" : "继续第二节。");
		}),
	);
	const options = {
		model,
		systemPrompt: "测试",
		tools: [],
		budget: { maxTurns: 20 },
		saveCheckpoint: async (next: LoopCheckpoint) => {
			saved = structuredClone(next);
			if (!crashed && next.phase === "tools" && next.calls.at(-1)?.purpose === "compaction") {
				crashed = true;
				throw new Error("crash after durable summary response");
			}
		},
	};
	await assert.rejects(runTaskLoop({ ...options, checkpoint }), /crash after durable/u);
	assert.equal(count, 1);
	await runTaskLoop({ ...options, checkpoint: saved });
	assert.equal(saved.calls.filter((c) => c.state === "received").length, count);
	assert.ok(saved.calls.every((c) => c.usageRecorded));
	assert.equal(saved.phase, "settled");
});

test("超限摘要之后遇到瞬时错误：普通重试不重复强制摘要，不误报第二次超限", async () => {
	const { provider, model } = await fixture(1000000);
	const checkpoint = await history(model, provider);
	provider.setResponses([
		overflow(1000, 900),
		fauxAssistantMessage("原要求已整理。"),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "server_busy" }),
		fauxAssistantMessage("继续创作。"),
	]);
	const result = await runTaskLoop({
		model,
		systemPrompt: "测试",
		checkpoint,
		tools: [],
		budget: { maxTurns: 10 },
		transientRetry: { maxRetries: 1, baseDelayMs: 0 },
	});
	assert.equal(result.stop, "model_stopped");
});

test("摘要自身重试：摘要进度与退避进度的事件身份不冲突", async () => {
	const { provider, model } = await fixture(8000);
	const checkpoint = await history(model, provider);
	provider.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "server_busy" }),
		...Array.from(
			{ length: 20 },
			() => async (context: Transcript) =>
				fauxAssistantMessage(isSummary(context) ? "新要求有效，继续第二节。" : "完成。"),
		),
	]);
	const events = new Map<string, string>();
	const result = await runTaskLoop({
		model,
		systemPrompt: "测试",
		checkpoint,
		tools: [],
		budget: { maxTurns: 20 },
		transientRetry: { maxRetries: 1, baseDelayMs: 0 },
		onProgress: (id, label, status, summary) => {
			const key = `${id}:${status}`;
			const body = JSON.stringify({ label, status, summary });
			if (events.has(key)) assert.equal(events.get(key), body);
			events.set(key, body);
		},
	});
	assert.equal(result.stop, "model_stopped");
});
