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
 * 会话永续，上下文就必须有生命周期（2026-10-01 Harness 审查 F3）：请求接近窗口时先清掉较早的工具结果，
 * 仍然太大就请模型压缩，provider 报超限时清理后重试一次，实在放不下就如实报 context_overflow。
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
		replay: "read",
		async prepare() {
			count += 1;
			return { content: [{ type: "text" as const, text: `第${count}段：${"黄盖受刑".repeat(size / 4)}` }] };
		},
		async execute(_id, _params, _signal, _update, prepared) {
			return prepared as { content: { type: "text"; text: string }[] };
		},
	};
}

/** 校准前的估计不超过窗口、校准后又高于压缩线的长度；faux 按字符数 / 4 计，harness 起初按字节数 / 3 估。 */
const PROMPT_CHARS = 17000;

function lastToolResults(context: Transcript): string[] {
	return context.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
}

test("请求接近窗口时清掉较早的工具结果：发出的请求不超窗口，原消息不改，最近一次的结果保留", async () => {
	const window = 4000;
	const { provider, model } = await fixture(window);
	const seen: Transcript[] = [];
	const step = async (context: Transcript) => {
		seen.push(context);
		const tokens = tokensOf(context);
		if (tokens > window) return overflow(tokens, window);
		return seen.length <= 8 ? fauxAssistantMessage(fauxToolCall("big", {})) : fauxAssistantMessage("读完了");
	};
	provider.setResponses(Array.from({ length: 9 }, () => step));
	let checkpoint: LoopCheckpoint | undefined;
	const outcome = await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "反复读",
		tools: [bigTool(2400)],
		budget: { maxTurns: 20 },
		saveCheckpoint: async (next) => {
			checkpoint = structuredClone(next);
		},
	});
	assert.equal(outcome.stop, "model_stopped");
	assert.ok(
		seen.every((context) => tokensOf(context) <= window),
		"每个请求都在窗口内",
	);
	const last = lastToolResults(seen.at(-1) as Transcript);
	assert.match(last.at(-1) ?? "", /^第8段：/u, "最近一次的结果原样发送");
	assert.ok(
		last.some((text) => text.includes("已清除")),
		"较早的结果换成了占位",
	);
	const stored = (checkpoint?.messages ?? []).filter((message) => message.role === "toolResult");
	assert.equal(stored.length, 8);
	assert.ok(
		stored.every((message) => JSON.stringify(message.content).includes("黄盖受刑")),
		"checkpoint 里的原消息一字不改",
	);
});

test("provider 报上下文超限时清掉较早的工具结果重试一次，turn 照常结束", async () => {
	// 模型目录说窗口很大，provider 实际只收 4000：主动清理不会触发，靠报错后的重试兜住。
	const limit = 4000;
	const { provider, model } = await fixture(1_000_000);
	let overflows = 0;
	let calls = 0;
	const step = async (context: Transcript) => {
		calls += 1;
		const tokens = tokensOf(context);
		if (tokens > limit) {
			overflows += 1;
			return overflow(tokens, limit);
		}
		return lastToolResults(context).length < 9
			? fauxAssistantMessage(fauxToolCall("big", {}))
			: fauxAssistantMessage("读完了");
	};
	provider.setResponses(Array.from({ length: 12 }, () => step));
	let checkpoint: LoopCheckpoint | undefined;
	const outcome = await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "反复读",
		tools: [bigTool(2400)],
		budget: { maxTurns: 20 },
		saveCheckpoint: async (next) => {
			checkpoint = structuredClone(next);
		},
	});
	assert.equal(outcome.stop, "model_stopped");
	assert.equal(overflows, 1, "清理后重试一次就够了");
	assert.ok(
		!(checkpoint?.messages ?? []).some((message) => message.role === "assistant" && message.stopReason === "error"),
		"报超限的那次响应撤回，不留在消息列表里",
	);
	assert.ok(calls <= 12);
});

test("清掉工具结果后仍然偏大：请求末尾请模型先 compact_context，压缩后接着做", async () => {
	const window = 6000;
	const { provider, model } = await fixture(window);
	const seen: Transcript[] = [];
	let compacted = false;
	const step = async (context: Transcript) => {
		seen.push(context);
		const tokens = tokensOf(context);
		if (tokens > window) return overflow(tokens, window);
		const last = context.messages.at(-1);
		const asked = last?.role === "user" && JSON.stringify(last.content).includes("compact_context");
		if (asked && !compacted) {
			compacted = true;
			return fauxAssistantMessage(fauxToolCall("compact_context", { summary: "已经讨论了黄盖诈降的代价。" }));
		}
		if (compacted) return fauxAssistantMessage("压缩后接着说完。");
		// 工具结果很小，清不出多少；占地方的是模型自己的长回复。
		return fauxAssistantMessage([
			{ type: "text", text: "黄盖在军杖落下前停了一下。".repeat(120) },
			fauxToolCall("note", { n: seen.length }),
		]);
	};
	provider.setResponses(Array.from({ length: 30 }, () => step));
	const note: HarnessTool = {
		name: "note",
		description: "记一笔",
		// 每次记的不一样：同一动作同一结果连续三次会被当成空转停下（run_no_progress）。
		parameters: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
		replay: "read",
		prepare: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		execute: async (_id, _params, _signal, _update, prepared) =>
			prepared as { content: { type: "text"; text: string }[] },
	};
	const { compactContextTool } = await import("../src/harness/tools.js");
	const outcome = await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "讨论",
		tools: [note, compactContextTool()],
		budget: { maxTurns: 40 },
	});
	assert.equal(outcome.stop, "model_stopped");
	assert.equal(compacted, true, "模型被请求压缩并照做了");
	assert.ok(
		seen.every((context) => tokensOf(context) <= window),
		"没有请求超出窗口",
	);
	assert.ok(tokensOf(seen.at(-1) as Transcript) < tokensOf(seen.at(-2) as Transcript), "压缩之后请求变小");
});

test("作者的开场消息本身就超过压缩线：压不动就不再要求压缩，接着做，不陷入一次次压缩", async () => {
	// 2026-10-04 三国前五十回的抽取：补全子任务的开场消息带整份抽取，光它就超过压缩线。压缩只压得动工具结果与
	// 模型回复，作者消息原样保留，于是每次请求都要求压缩、模型每次照做，5 个子任务各压了 40–50 次、一个文件没写，
	// 没有预算的创作路径就这样一直烧下去。
	const window = 6000;
	const { provider, model } = await fixture(window);
	let compactions = 0;
	let notes = 0;
	const step = async (context: Transcript) => {
		const tokens = tokensOf(context);
		if (tokens > window) return overflow(tokens, window);
		const last = context.messages.at(-1);
		if (last?.role === "user" && JSON.stringify(last.content).includes("compact_context")) {
			compactions += 1;
			return fauxAssistantMessage(fauxToolCall("compact_context", { summary: "还没开始补全。" }));
		}
		notes += 1;
		return notes <= 3 ? fauxAssistantMessage(fauxToolCall("note", { n: notes })) : fauxAssistantMessage("补完了。");
	};
	provider.setResponses(Array.from({ length: 40 }, () => step));
	const note: HarnessTool = {
		name: "note",
		description: "记一笔",
		parameters: Type.Object({ n: Type.Number() }, { additionalProperties: false }),
		replay: "read",
		prepare: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		execute: async (_id, _params, _signal, _update, prepared) =>
			prepared as { content: { type: "text"; text: string }[] },
	};
	const { compactContextTool } = await import("../src/harness/tools.js");
	const outcome = await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: `整份抽取：${"x".repeat(PROMPT_CHARS)}`,
		tools: [note, compactContextTool()],
		budget: { maxTurns: 30 },
	});
	assert.equal(outcome.stop, "model_stopped", `停在 ${outcome.stop}，压缩了 ${compactions} 次`);
	assert.ok(compactions <= 1, `压缩了 ${compactions} 次`);
	assert.equal(notes, 4, "压不动之后照常干活");
});

test("清完仍放不下：重试一次后如实报 context_overflow，不无限重发", async () => {
	const limit = 1000;
	const { provider, model } = await fixture(1_000_000);
	let calls = 0;
	provider.setResponses(
		Array.from({ length: 5 }, () => async (context: Transcript) => {
			calls += 1;
			return overflow(tokensOf(context), limit);
		}),
	);
	await assert.rejects(
		runTaskLoop({
			model,
			systemPrompt: "测试",
			prompt: "作者贴进来的一整章。".repeat(800),
			tools: [],
			budget: { maxTurns: 20 },
		}),
		(error: { code?: string; message?: string }) =>
			error.code === "context_overflow" && /新对话/u.test(error.message ?? ""),
	);
	assert.ok(calls <= 2, `最多重试一次，实际 ${calls} 次`);
});

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
	const tool = (name: string, replay: HarnessTool["replay"], text: string, boundary = false): HarnessTool => ({
		name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		replay,
		prepare: async () => ({
			content: [{ type: "text" as const, text }],
			...(boundary ? { contextBoundary: true } : {}),
		}),
		execute: async (_id, _params, _signal, _update, prepared) =>
			prepared as { content: { type: "text"; text: string }[] },
		...(replay === "reconcile"
			? {
					reconcile: async (_id: string, _params: unknown, prepared: unknown) =>
						prepared as { content: { type: "text"; text: string }[] },
				}
			: {}),
	});
	await runTaskLoop({
		model,
		systemPrompt: "测试",
		prompt: "读、委派、提交",
		tools: [
			bigTool(FOLD_SIZE),
			tool("delegate", "reconcile", `子任务交付：${"阚泽献书".repeat(FOLD_SIZE / 4)}`),
			tool("small", "read", "小结果"),
			tool("commit", "reconcile", "已提交 r2", true),
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
