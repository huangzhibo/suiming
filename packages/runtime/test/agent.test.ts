import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createModels,
	type FauxModelDefinition,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonObject,
	Type,
} from "@earendil-works/pi-ai";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { agentTurn } from "../src/harness/agent.js";
import type { LoopCheckpoint } from "../src/harness/loop.js";
import type { TurnOptions } from "../src/harness/suiming-harness.js";
import type { HarnessTool } from "../src/harness/tool.js";
import type { ExecutionStateDelta, SessionRecord } from "../src/index.js";
import {
	InMemoryExecutionState,
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	SqliteLocalStore,
	SuimingHarness,
	SuimingHarnessError,
	TURN_USAGE_CHECKPOINT_TOKENS,
	weightedUsage,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

const CHECKPOINT_MEDIA_TYPE = "application/vnd.suiming.harness-checkpoint+json";

async function fixture(
	options: {
		telemetryContext?: TelemetryContext;
		models?: FauxModelDefinition[];
		turnUsageCheckpointTokens?: number;
	} = {},
) {
	const { telemetryContext } = options;
	const root = await mkdtemp(join(tmpdir(), "suiming-agent-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-agent" });
	const provider = fauxProvider({ provider: "agent-test", ...(options.models ? { models: options.models } : {}) });
	const alternate = fauxProvider({ provider: "agent-alternate" });
	const models = createModels();
	models.setProvider(provider.provider);
	models.setProvider(alternate.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const gateway = new ModelGateway(models, { profiles: { main: profile, reviewer: profile } });
	const harness = new SuimingHarness({
		...(telemetryContext ? { telemetryContext } : {}),
		...(options.turnUsageCheckpointTokens === undefined
			? {}
			: { turnUsageCheckpointTokens: options.turnUsageCheckpointTokens }),
		project,
		models: gateway,
	});
	return {
		root,
		project,
		provider,
		alternate,
		gateway,
		harness,
		/** 作者说一句话（或不说）并跑完一个 turn；缺省新建 session。 */
		async say(text: string | undefined, sessionId?: string, turn: TurnOptions = {}) {
			const id = sessionId ?? (await harness.createSession()).id;
			if (text !== undefined) project.queueInbox(id, text);
			const outcome = await harness.turn(id, turn, (session) => agentTurn(session));
			return { sessionId: id, ...outcome };
		},
		/** Agent 与作者共用一份 checkout：候选就在作品目录里。 */
		checkoutFile(path: string) {
			return readFile(join(root, path), "utf8");
		},
		async close() {
			project.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));
const reply = (text: string) => fauxAssistantMessage(text);

test("write / edit 带 check: true：写完一并返回 Checker 结论，省掉紧跟着的一次 check 来回", async () => {
	// 斗破运行里 Writer 写一节要 write 三四次、每次后面再来一次 check；合并之后一次观察拿到两者。
	const f = await fixture();
	try {
		const lastText = (context: { messages: readonly { role: string; content?: unknown }[] }) => {
			const part = (context.messages.at(-1)?.content as { type: string; text?: string }[] | undefined)?.[0];
			return part?.type === "text" ? (part.text ?? "") : "";
		};
		f.provider.setResponses([
			call("write", {
				path: "intent/计谋的代价.md",
				content: "揭示真相必须让选择者承担不可逆的后果。",
				check: true,
			}),
			async (context) => {
				const result = lastText(context);
				assert.match(result, /^已写入 intent\/计谋的代价\.md，\d+ 字/u);
				assert.match(result, /\n\n检查：PASSED/u, "写入结果后面接着 Checker 结论");
				return call("edit", {
					path: "world/characters/黄盖.md",
					oldText: "name: 黄盖",
					newText: "name: 黄盖\nfamily:\n  parent: [不存在的人]",
					check: true,
				});
			},
			async (context) => {
				const result = lastText(context);
				assert.match(result, /^已修改 world\/characters\/黄盖\.md/u);
				assert.match(result, /检查：FAILED/u, "检查不过也如实返回，改动已经落盘");
				return call("write", { path: "intent/另一条.md", content: "不带 check 的写入只返回写入结果。" });
			},
			async (context) => {
				assert.doesNotMatch(lastText(context), /检查：/u);
				return reply("改完了，黄盖的引用还要修。");
			},
		]);
		const outcome = await f.say("改两处");
		assert.equal(outcome.failure, undefined);
	} finally {
		await f.close();
	}
});

test("delete 从候选里真的移除 artifact；删掉仍被引用的文件由 Checker 挡住，是工具失败不是 turn 崩溃", async () => {
	const f = await fixture();
	try {
		// 删一份已经结晶进故事事实的 Intent——Story Language 明写这类 Intent 应当合并或删除。
		f.provider.setResponses([
			call("delete", { path: "intent/计谋的代价.md" }),
			call("commit", { summary: "这条 Intent 已经落进 Beat，删除" }),
			reply("已删除并提交"),
		]);
		const removed = await f.say("删掉那条已经结晶的 Intent");
		assert.equal(removed.session.status, "idle");
		assert.equal(removed.failure, undefined);
		assert.equal(removed.value?.reply, "已删除并提交");
		const after = await f.project.exportRevision();
		assert.equal(
			after.some((file) => file.path === "intent/计谋的代价.md"),
			false,
			"删除必须进入 Canon，而不是只改了工作区",
		);

		// 删一个仍被 refs 指着的人物：Checker 必须挡住，而且拒绝要作为可修复的工具失败回到模型手里。
		const head = f.project.project().headRevisionId;
		const liMu = await readFile(join(f.root, "world/characters/黄盖.md"), "utf8");
		f.provider.setResponses([
			call("delete", { path: "world/characters/黄盖.md" }),
			call("commit", { summary: "删掉黄盖" }),
			async (context) => {
				const last = JSON.stringify(context.messages.at(-1));
				assert.match(last, /黄盖/u, "Checker 的拒绝要回到模型手里");
				assert.match(last, /找不到引用 character/u, "诊断逐条给出，模型才知道改哪里");
				assert.match(last, /换掉这条引用/u, "Checker 算出的修复提示也要到模型手里，不能只给路径和 message");
				return call("write", { path: "world/characters/黄盖.md", content: liMu });
			},
			reply("黄盖仍被引用，已放回"),
		]);
		const blocked = await f.say("删掉黄盖", removed.sessionId);
		assert.equal(blocked.failure, undefined, "被 Checker 拒绝是一次可修复的失败，不是 turn 崩溃");
		assert.equal(f.project.project().headRevisionId, head, "被 Checker 拒绝的删除不得推进 Canon");

		// 删一个不存在的文件不是「成功」，是模型记错了路径。
		f.provider.setResponses([
			call("delete", { path: "world/characters/查无此人.md" }),
			async (context) => {
				assert.match(JSON.stringify(context.messages.at(-1)), /file_not_found|查无此人/u);
				return reply("路径不存在");
			},
		]);
		await f.say("删掉一个不存在的人物", removed.sessionId);
	} finally {
		await f.close();
	}
});

test("turn 结束事件带对账：作者几条、意图 / Design / 正文各改了什么、提交了几个版本、还剩几个未提交", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "真相公开必须当场付出不可逆的代价。" }),
			call("commit", { summary: "写回意图" }),
			call("write", { path: "text/beat-0001.md", content: "军杖落到第三十下。" }),
			reply("意图已写回并提交；正文初稿还没提交。"),
		]);
		await f.say("真相必须当场付出代价，记进意图", id);
		const summaries = () =>
			f.project
				.readSessionEvents(id)
				.map((record) => record.event)
				.filter((event) => event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.turn");
		const none = { count: 0, paths: [] };
		const first = summaries()[0];
		assert.ok(first?.type === "ACTIVITY_SNAPSHOT");
		assert.deepEqual(first.content, {
			authorMessages: 1,
			changed: {
				intent: { count: 1, paths: ["intent/计谋的代价.md"] },
				design: none,
				text: { count: 1, paths: ["text/beat-0001.md"] },
				review: none,
				other: none,
			},
			revisions: 1,
			uncommitted: 1,
			textWithoutContext: { count: 1, paths: ["text/beat-0001.md"] },
		});
		const types = f.project
			.readSessionEvents(id)
			.map((record) => (record.event.type === "ACTIVITY_SNAPSHOT" ? record.event.activityType : record.event.type));
		assert.ok(types.indexOf("suiming.turn") < types.indexOf("RUN_FINISHED"), "对账在 turn 结束之前发出");

		// 只讨论的 turn：本轮没改作品、没提交；未提交数是 turn 结束时 checkout 的实况。
		f.provider.setResponses([reply("可以，先这样。")]);
		await f.say("就这样？", id);
		assert.deepEqual(summaries()[1]?.type === "ACTIVITY_SNAPSHOT" && summaries()[1]?.content, {
			authorMessages: 1,
			changed: { intent: none, design: none, text: none, review: none, other: none },
			revisions: 0,
			uncommitted: 1,
			textWithoutContext: none,
		});
	} finally {
		await f.close();
	}
});

test("对账点名根 Agent 没取写作依据就整篇写入的正文；取过 write_context、委派 writer 的不算，小改不算", async () => {
	// 2026-10-02 斗破留出评测：根 Agent 没委派 Writer、也没调 write_context，三节正文都是自己凭 Frame 写的，
	// 再用 118 次 edit 凑篇幅；写作方法与硬边界只跟着 Write Context 到，没人发现它跳过了。
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([
			call("write_context", { storyBeatId: "beat-0001" }),
			call("write", { path: "text/beat-0001.md", content: "军杖落下，周瑜就坐在帐前。" }),
			call("write", { path: "text/beat-0002.md", content: "他把火船藏进袖中。" }),
			call("edit", { path: "text/beat-0001.md", oldText: "周瑜就坐在帐前", newText: "周瑜背过身去" }),
			reply("两节都写了。"),
		]);
		await f.say("写前两节", id);
		const withoutContext = () =>
			f.project
				.readSessionEvents(id)
				.map((record) => record.event)
				.flatMap((event) =>
					event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.turn"
						? [(event.content as { textWithoutContext: unknown }).textWithoutContext]
						: [],
				);
		assert.deepEqual(withoutContext()[0], { count: 1, paths: ["text/beat-0002.md"] });

		// 委派 writer 的那一节：子任务自己拿 Write Context，它的写入不算
		f.provider.setResponses([
			call("delegate", { profile: "writer", storyBeatId: "beat-0002", goal: "重写第二节" }),
			call("write", { path: "text/beat-0002.md", content: "他把火船折好，藏进袖中最深处。" }),
			call("submit_task", { summary: "写好了" }),
			reply("交给 Writer 重写了第二节。"),
		]);
		await f.say("第二节交给 Writer 重写", id);
		assert.deepEqual(withoutContext()[1], { count: 0, paths: [] });
	} finally {
		await f.close();
	}
});

test("作者消息后的状态附注在取走消息时现算；开场写明是会话开始时的快照", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([
			async () => {
				// turn 进行中作者又说了一句：它在 Agent 改过文件之后才进消息列表。
				f.project.queueInbox(id, "补充：代价要当场兑现");
				return call("write", { path: "intent/计谋的代价.md", content: "真相公开须承担不可逆代价。" });
			},
			async (context) => {
				// pi-ai 0.99 起 transcript 开头是折进去的 system message，作者的开场是第一条 user 消息。
				const opening = JSON.stringify(context.messages.find((message) => message.role === "user"));
				assert.match(opening, /会话开始时的作品快照/u, "开场不再自称「本轮起点」的权威状态");
				const last = JSON.stringify(context.messages.at(-1));
				assert.match(last, /补充：代价要当场兑现/u);
				assert.match(last, /候选里未提交的文件 1 个/u, "附注反映取走消息时的候选，不是 turn 开始时的");
				return reply("已改意图，代价当场兑现。");
			},
		]);
		const outcome = await f.say("改一下意图", id);
		assert.equal(outcome.value?.reply, "已改意图，代价当场兑现。");
	} finally {
		await f.close();
	}
});

test("说完就停；同一 session 的下一句接着消息列表，新 session 隔离；只讨论不产生作品版本", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([reply("可选方案：让黄盖主动挨打诈降，并承担被自己人误会的代价。")]);
		const first = await f.say("讨论黄盖诈降的代价，不修改作品");
		assert.equal(first.session.status, "idle");
		assert.equal(first.session.turn, 1);
		assert.equal(first.value?.stop, "model_stopped");
		assert.equal(first.value?.reply, "可选方案：让黄盖主动挨打诈降，并承担被自己人误会的代价。");
		assert.equal(f.provider.state.callCount, 1);
		assert.equal((await f.project.history()).length, 1);

		f.provider.setResponses([
			async (context) => {
				const input = JSON.stringify(context.messages);
				assert.match(input, /讨论黄盖诈降的代价/);
				assert.match(input, /承担失去信任的代价/);
				assert.match(input, /这个方案还有什么问题/);
				assert.match(input, /\[系统附注：当前版本/, "作者消息后面附确定性状态行");
				return reply("需要补足黄盖为何愿意承担这个代价的依据。");
			},
		]);
		const second = await f.say("这个方案还有什么问题？", first.sessionId);
		assert.equal(second.session.turn, 2);
		assert.equal(second.session.inboxSequence, 2);
		assert.equal((await f.project.history()).length, 1);
		const events = f.project.readSessionEvents(first.sessionId);
		assert.deepEqual(
			events.filter((item) => item.event.type === "RUN_STARTED").map((item) => item.event.threadId),
			[first.sessionId, first.sessionId],
		);
		assert.equal(
			new Set(events.filter((item) => item.event.type === "RUN_STARTED").map((item) => item.event.runId)).size,
			2,
			"每个 turn 一个 AG-UI runId",
		);
		assert.ok(events.some((item) => JSON.stringify(item.event).includes("这个方案还有什么问题")));

		f.provider.setResponses([
			async (context) => {
				assert.doesNotMatch(JSON.stringify(context.messages), /可选方案：|这个方案还有什么问题/);
				return reply("可以一起讨论叙事节奏。");
			},
		]);
		const separate = await f.say("我们聊聊叙事节奏");
		assert.notEqual(separate.sessionId, first.sessionId);
		assert.equal(f.project.loadExecutionState().sessions.length, 2);
	} finally {
		await f.close();
	}
});

test("turn 进行中作者补一句：模型停下时 inbox 有新消息就在同一 turn 里继续；turn 结束后的消息等下一个 turn", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		const correction = "请改为分析黄盖的选择";
		f.provider.setResponses([
			async () => {
				f.project.queueInbox(id, correction);
				return reply("旧回答");
			},
			async (context) => {
				assert.ok(
					context.messages.some(
						(message) => message.role === "user" && String(message.content).startsWith(correction),
					),
				);
				return reply("黄盖主动选择挨打诈降");
			},
		]);
		const outcome = await f.say("讨论赤壁", id);
		assert.equal(outcome.value?.reply, "黄盖主动选择挨打诈降");
		assert.equal(f.provider.state.callCount, 2);
		assert.equal(outcome.session.inboxSequence, 2);
		assert.ok(JSON.stringify(f.project.readSessionEvents(id)).includes(correction), "事件里是作者原话");
		f.project.queueInbox(id, "停下之后说的");
		assert.equal(f.harness.session(id).status, "idle");
		assert.equal(f.harness.pendingInbox(id), 1, "turn 结束后的消息留给下一个 turn");
	} finally {
		await f.close();
	}
});

test("连续重复同一被拒绝动作：turn 以 run_no_progress 结束回 idle；作者下一句就能续", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([call("missing_tool", {}), call("missing_tool", {}), call("missing_tool", {})]);
		const stuck = await f.say("仅分析现有设计");
		assert.equal(stuck.failure?.code, "run_no_progress");
		assert.equal(stuck.session.status, "idle");
		assert.equal(stuck.session.lastFailure?.code, "run_no_progress");
		assert.equal(stuck.session.lease, undefined);
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /停止寻找不存在/);
				return reply("当前设计已有明确的主动选择要求");
			},
		]);
		const next = await f.say("停止寻找不存在的工具，给出已有分析", stuck.sessionId);
		assert.equal(next.failure, undefined);
		assert.equal(next.session.lastFailure, undefined);
		assert.equal(f.provider.state.callCount, 4);
	} finally {
		await f.close();
	}
});

test("同一动作得到同一结果连续三次，成功的也算：以 run_no_progress 结束；中间结果变了就不算", async () => {
	// opencode 的一个子任务把同一个 grep 成功执行了 364 次、50 分钟；只认被拒的动作就拦不住它。
	const f = await fixture();
	try {
		const read = () => call("read", { path: "world/characters/黄盖.md" });
		f.provider.setResponses([read(), read(), read(), reply("不该发出：同一结果已经读了三次")]);
		const stuck = await f.say("看看黄盖");
		assert.equal(stuck.failure?.code, "run_no_progress");
		assert.equal(f.provider.state.callCount, 3);
		f.provider.setResponses([
			read(),
			call("edit", {
				path: "world/characters/黄盖.md",
				oldText: "name: 黄盖",
				newText: "name: 黄盖\n# 重读之前改过",
			}),
			read(),
			read(),
			reply("改过之后重读，结果不同，不算重复"),
		]);
		const next = await f.say("改一下再看", stuck.sessionId);
		assert.equal(next.failure, undefined);
	} finally {
		await f.close();
	}
});

test("连续五次回复的动作都被拒绝、每次都不一样：同样以 run_no_progress 结束，不等它换着花样一直试", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			...["甲", "乙", "丙", "丁", "戊"].map((word) =>
				call("edit", { path: "world/characters/黄盖.md", oldText: `不存在的原文${word}`, newText: "改过" }),
			),
			reply("不该发出：已经连续五次被拒"),
		]);
		const stuck = await f.say("改黄盖");
		assert.equal(stuck.failure?.code, "run_no_progress");
		assert.equal(stuck.session.status, "idle");
		assert.equal(f.provider.state.callCount, 5);
	} finally {
		await f.close();
	}
});

/** 只按输出计价，每个输出 token $0.001：花费由回复本身的长短决定，测试里算得准。 */
const PRICED_MODEL: FauxModelDefinition = {
	id: "priced",
	cost: { input: 0, output: 1_000, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
};
/** 4 万字符的回复按 1 万个输出 token 计：折算用量 5 万（输出按五倍），在 PRICED_MODEL 上约 $10。 */
const expensive = (toolCall: ReturnType<typeof fauxToolCall>) =>
	fauxAssistantMessage([fauxText("x".repeat(40_000)), toolCall]);

test("折算用量分得开空转与正常的重活：缓存读按一成、输出按五倍；原始 token 总数分不开", () => {
	// 真实运行的 token 构成（GPT-6.1 Sol）。空转几乎全是未缓存请求，正常的长任务大多命中缓存。
	const loop = { input: 45_185_916, cacheRead: 3_117_696, cacheWrite: 0, output: 131_591 }; // 三国补全空转，$92
	const doupo = { input: 3_387_406, cacheRead: 35_731_072, cacheWrite: 0, output: 366_577 }; // 斗破整本抽取，$14
	const sanguo = { input: 1_595_826, cacheRead: 15_520_384, cacheWrite: 0, output: 340_998 }; // 三国分段 + 整合，$8
	const raw = (u: typeof loop) => u.input + u.cacheRead + u.cacheWrite + u.output;
	assert.ok(raw(loop) < raw(doupo) * 1.3, "原始 token 总数上两者差不到三成");
	assert.ok(weightedUsage(loop) > weightedUsage(doupo) * 5, "折算之后差五倍以上");
	assert.ok(weightedUsage(loop) > TURN_USAGE_CHECKPOINT_TOKENS * 7, "空转在检查点的七分之一处就会停");
	assert.ok(weightedUsage(doupo) > TURN_USAGE_CHECKPOINT_TOKENS, "最重的正常单轮撞线一次");
	assert.ok(weightedUsage(sanguo) < TURN_USAGE_CHECKPOINT_TOKENS, "三国的分段加整合一轮做完");
});

test("一轮的折算用量到检查点：下一次请求之前停下回 idle，说明用了多少、估算花了多少；作者说继续就接着跑", async () => {
	// 2026-10-04 抽三国时 5 个补全子任务在压缩里空转了 19 分钟、估算 $92，没有任何东西停住它们。
	const f = await fixture({ models: [PRICED_MODEL], turnUsageCheckpointTokens: 50_000 });
	try {
		f.provider.setResponses([expensive(fauxToolCall("project_status", {})), reply("不该发出的第二次请求")]);
		const stopped = await f.say("看看作品状态，然后一直做下去");
		assert.equal(stopped.session.status, "idle");
		assert.equal(stopped.failure?.code, "turn_usage_checkpoint");
		assert.match(stopped.failure?.message ?? "", /折合 \d+ 万 token/u, "说清这一轮用了多少");
		assert.match(stopped.failure?.message ?? "", /\$10\.\d{2}/u, "也说估算花了多少");
		assert.match(stopped.failure?.message ?? "", /继续/u);
		assert.equal(f.provider.state.callCount, 1, "到线之后一个请求也不再发");
		f.provider.setResponses([
			async (context) => {
				const encoded = JSON.stringify(context.messages);
				assert.match(encoded, /committedRevisionCount/u, "停下之前的工具结果还在消息列表里");
				assert.match(encoded, /继续/u);
				return reply("接着做完了");
			},
		]);
		const next = await f.say("继续", stopped.sessionId);
		assert.equal(next.failure, undefined);
		assert.equal(next.session.lastFailure, undefined);
		assert.equal(f.provider.state.callCount, 2);
	} finally {
		await f.close();
	}
});

test("用量检查点与模型价格无关、根与子任务合计；落在子任务里不算失败，继续时从它自己的 checkpoint 接着跑", async () => {
	// 缺省的 faux 模型目录价为 0：按花费算的检查点在这里永远不触发，换成 DeepSeek 这类便宜模型也差不多。
	const f = await fixture({ turnUsageCheckpointTokens: 50_000 });
	try {
		f.provider.setResponses([
			call("delegate", { goal: "读黄盖的人物档后交付", profile: "main" }),
			expensive(fauxToolCall("read", { path: "world/characters/黄盖.md" })),
			reply("不该发出：子任务已到用量检查点"),
		]);
		const stopped = await f.say("让子任务看看黄盖");
		assert.equal(stopped.failure?.code, "turn_usage_checkpoint");
		assert.doesNotMatch(stopped.failure?.message ?? "", /\$/u, "目录价为 0 就不报花费");
		assert.equal(f.provider.state.callCount, 2);
		const [task] = f.project.loadExecutionState().tasks;
		assert.equal(task?.status, "interrupted", "不是子任务失败：父模型收到失败会重派一个，从头再花一遍");
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /name: 黄盖/u, "子任务停下之前读到的内容还在");
				return call("submit_task", { summary: "黄盖的人物档读过了" });
			},
			async (context) => {
				const encoded = JSON.stringify(context.messages);
				assert.match(encoded, /黄盖的人物档读过了/u);
				assert.match(encoded, /继续/u);
				return reply("子任务交付了");
			},
		]);
		const next = await f.say("继续", stopped.sessionId);
		assert.equal(next.failure, undefined);
		const tasks = f.project.loadExecutionState().tasks;
		assert.equal(tasks.length, 1, "续跑的是同一个子任务，不是重派一个");
		assert.equal(tasks[0]?.status, "completed");
		assert.equal(f.provider.state.callCount, 4);
	} finally {
		await f.close();
	}
});

test("作品状态来自版本真源，候选修改不会冒充已提交版本", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /committedRevisionCount/);
				return call("write", { path: "intent/计谋的代价.md", content: "选择必须承担后果。" });
			},
			call("project_status", {}),
			async (context) => {
				const result = context.messages.at(-1);
				assert.equal(result?.role, "toolResult");
				const part = Array.isArray(result?.content) ? result.content[0] : undefined;
				assert.ok(part?.type === "text");
				const status = JSON.parse(part.text);
				assert.equal(status.committedRevisionCount, 1);
				assert.equal(status.candidate.uncommittedChanges, 1);
				assert.equal(status.committed.storyBeats, 2);
				return call("commit", { summary: "提交要求" });
			},
			call("project_status", {}),
			async (context) => {
				assert.match(JSON.stringify(context.messages.at(-1)), /committedRevisionCount\\":2/);
				return reply("版本状态已核对");
			},
		]);
		const outcome = await f.say("修改并核对版本");
		assert.equal(outcome.failure, undefined);
	} finally {
		await f.close();
	}
});

test("Agent 直接修改与阶段提交，不强制 Review 或子任务；不属于作品的文件不进版本，提交结果点名", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "揭示真相必须让选择者承担不可逆的后果。" }),
			call("write", { path: "scripts/count.py", content: "print('统计用词频率')\n" }),
			call("commit", { summary: "强化后果" }),
			async (context) => {
				const result = context.messages.at(-1);
				const part = Array.isArray(result?.content) ? result.content[0] : undefined;
				assert.ok(part?.type === "text");
				const parsed = JSON.parse(part.text) as {
					revisionId?: string;
					revisionLabel?: string;
					ignored?: string[];
					committed?: string[];
				};
				assert.ok(parsed.revisionId);
				// 作者看到的是 r2 这样的版本号；不给的话模型自己推，斗破运行里一直少报一位（r7 说成 r6）。
				assert.equal(parsed.revisionLabel, "r2");
				assert.deepEqual(parsed.committed, ["intent/计谋的代价.md"], "进版本的文件如实列出");
				// checkout 里的仓库辅助文件都点名（`.gitattributes` 是建仓时写的），与 `suim diff` 的 ignored 同一份。
				assert.deepEqual(parsed.ignored, [".gitattributes", "scripts"], "提交结果要点名没进版本的文件");
				return reply("已提交明确的后果要求；scripts/count.py 只在工作区");
			},
		]);
		const outcome = await f.say("强化后果，顺便写个统计脚本");
		assert.equal(outcome.failure, undefined);
		assert.equal(f.project.loadExecutionState().tasks.length, 0);
		assert.equal((await f.project.history()).length, 2);
		const files = await f.project.exportRevision();
		assert.equal(
			files.some((file) => file.path === "scripts/count.py"),
			false,
		);
		assert.match(await f.checkoutFile("scripts/count.py"), /统计用词频率/);
		assert.ok(
			f.project
				.readSessionEvents(outcome.sessionId)
				.some(
					({ event }) =>
						event.type === "ACTIVITY_SNAPSHOT" && event.content.label === "commit" && !event.content.isError,
				),
		);
	} finally {
		await f.close();
	}
});

test("Agent 按模型决定调用独立 Review，经持久引用取得报告后提交", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "真相必须来自主动选择，并有不可逆代价。" }),
			call("review", { layer: "design", goal: "核对因果与代价" }),
			call("submit_review", {
				verdict: "pass",
				summary: "因果与代价一致",
				findings: [],
				uncovered: [],
				uncertainties: [],
			}),
			async (context) => {
				const message = context.messages.at(-1);
				assert.equal(message?.role, "toolResult");
				const content = message?.content;
				assert.ok(Array.isArray(content));
				const body = content.find((part) => part.type === "text");
				assert.ok(body?.type === "text");
				const handoff = JSON.parse(body.text) as { resultObjectId: string };
				return call("read_result", { resultObjectId: handoff.resultObjectId });
			},
			async (context) => {
				assert.ok(JSON.stringify(context.messages.at(-1)).includes("因果与代价一致"));
				return call("commit", { summary: "采纳候选" });
			},
			reply("修改、独立审查与提交完成"),
		]);
		const outcome = await f.say("改好后独立审查");
		assert.equal(outcome.failure, undefined);
		const tasks = f.project.loadExecutionState().tasks;
		assert.deepEqual(
			tasks.map((task) => [task.kind, task.status]),
			[["review", "completed"]],
		);
		assert.equal(tasks[0]?.sessionId, outcome.sessionId);
		assert.equal(tasks[0]?.parent?.taskId, undefined, "父是根 Agent");
		assert.ok(tasks[0]?.parent?.actionId);
		assert.ok(tasks[0]?.result?.id);
		assert.ok((await f.project.exportRevision()).some((file) => file.path.startsWith("review/design-")));
	} finally {
		await f.close();
	}
});

test("委派的子任务没交付：失败回到父模型手里作为工具错误，turn 不崩", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			call("delegate", { goal: "只检查代价，不修改文件", profile: "main" }),
			reply("看过了，代价明确"),
			reply("看过了"),
			reply("没有别的了"),
			async (context) => {
				const last = JSON.stringify(context.messages.at(-1));
				assert.match(last, /子任务没有完成/);
				assert.match(last, /task_not_submitted/);
				return reply("子任务没交付，我自己看过了：代价明确");
			},
		]);
		const outcome = await f.say("检查代价");
		assert.equal(outcome.failure, undefined);
		assert.equal(outcome.session.status, "idle");
		assert.equal(f.provider.state.callCount, 5);
		const tasks = f.project.loadExecutionState().tasks;
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0]?.kind, "subagent");
		assert.equal(tasks[0]?.status, "failed");
		assert.equal(tasks[0]?.failure?.code, "task_not_submitted");
	} finally {
		await f.close();
	}
});

test("模型结果未知才 paused；不授权重发就一直停着；换模型要先核对；重发后才能在边界换绑", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		const save = f.project.saveExecutionObject.bind(f.project);
		let crash = true;
		f.project.saveExecutionObject = async (mediaType, bytes) => {
			if (crash && mediaType === CHECKPOINT_MEDIA_TYPE) {
				const checkpoint = (await f.harness.checkpoints.read(bytes)) as { loop: LoopCheckpoint };
				if (checkpoint.loop.calls.some((item) => item.state === "received")) {
					crash = false;
					throw new Error("process exited before response persistence");
				}
			}
			return save(mediaType, bytes);
		};
		f.provider.setResponses([reply("第一次回答"), reply("重发后的回答")]);
		const first = await f.say("讨论作品", id);
		assert.equal(first.session.status, "idle", "普通故障回 idle 记一句");
		assert.match(first.failure?.message ?? "", /process exited/);

		// 下一个 turn 读到 checkpoint 里停在 effect_pending 的调用：远端结果未知，不问作者不能继续。
		const paused = await f.say(undefined, id);
		assert.equal(paused.session.status, "paused");
		assert.equal(paused.session.pause?.code, "model_call_unknown");
		assert.equal(paused.session.lease, undefined);
		assert.throws(() => f.project.queueInbox(id, "paused 不收消息"), { code: "session_paused" });
		await assert.rejects(f.say(undefined, id), { code: "session_paused" });
		const stillPaused = await f.say(undefined, id, { fromPaused: true });
		assert.equal(stillPaused.session.status, "paused", "恢复 checkpoint 本身不表示再次调用");
		const alternate = (
			await f.gateway.bind("main", { provider: f.alternate.provider.id, model: f.alternate.getModel().id })
		).snapshot;
		await assert.rejects(f.say(undefined, id, { fromPaused: true, model: alternate }), { code: "binding_mismatch" });
		assert.equal(f.provider.state.callCount, 1);

		const resumed = await f.say(undefined, id, { fromPaused: true, retryUnknownModelCall: true });
		assert.equal(resumed.session.status, "idle");
		assert.equal(resumed.value?.reply, "重发后的回答");
		assert.equal(f.provider.state.callCount, 2);
		assert.equal(resumed.session.model?.provider, f.provider.provider.id);

		// 没有未决副作用的边界才能换绑；inbox 空时不开新的模型调用。
		const switched = await f.say(undefined, id, { model: alternate });
		assert.equal(switched.session.model?.provider, f.alternate.provider.id);
		assert.equal(f.alternate.state.callCount, 0);
		f.alternate.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /重发后的回答/);
				return reply("新模型接着原对话");
			},
		]);
		const next = await f.say("换了模型再聊", id);
		assert.equal(next.value?.reply, "新模型接着原对话");
		assert.equal(f.alternate.state.callCount, 1);
	} finally {
		await f.close();
	}
});

test("执行命令只写自己改动的行：一个 turn 里整份导出与整份重读执行状态的次数与工具轮数无关", async (t) => {
	// 每条命令都整份克隆、整份重读时，成本随项目历史平方增长：100 轮后单轮簿记从 0.1 秒涨到 0.6 秒
	// （docs/validation/2026-10-01-harness-review F1）。计次数而不计时：与机器负载无关。
	const exported = t.mock.method(InMemoryExecutionState.prototype, "exportSnapshot");
	const loaded = t.mock.method(SqliteLocalStore.prototype, "loadExecutionState");
	const run = async (rounds: number) => {
		const f = await fixture();
		try {
			const id = (await f.harness.createSession()).id;
			f.provider.setResponses([
				// 两个文件交替读：同一动作同一结果连续三次会被当成空转停下（run_no_progress）。
				...Array.from({ length: rounds }, (_, index) =>
					call("read", { path: index % 2 === 0 ? "intent/计谋的代价.md" : "world/characters/黄盖.md" }),
				),
				reply("读完了"),
			]);
			exported.mock.resetCalls();
			loaded.mock.resetCalls();
			const outcome = await f.say("反复读意图", id);
			assert.equal(outcome.value?.reply, "读完了");
			return { exported: exported.mock.callCount(), loaded: loaded.mock.callCount() };
		} finally {
			await f.close();
		}
	};
	const few = await run(2);
	assert.deepEqual(await run(20), few);
});

test("半途恢复按这一轮冻结的工具声明：两轮之间升级过工具面也能续上，参数半途变了仍报 binding_mismatch", async () => {
	const f = await fixture();
	try {
		const probe = (description: string, parameters = Type.Object({}, { additionalProperties: false })) => ({
			name: "probe",
			description,
			replay: "reconcile" as const,
			parameters,
			prepare: async () => ({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
			reconcile: async () => ({ content: [{ type: "text" as const, text: "已核对" }] }),
		});
		const turn = (id: string, tool: HarnessTool, options: TurnOptions = {}) =>
			f.harness.turn(id, options, (session) => session.runRoot({ systemPrompt: "测试", tools: () => [tool] }));
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([reply("第一轮")]);
		f.project.queueInbox(id, "第一轮");
		assert.equal((await turn(id, probe("v1"))).session.status, "idle");

		// 第二轮工具描述升级成 v2；动作停在 effect_pending 时进程退出。
		const save = f.project.saveExecutionObject.bind(f.project);
		let crash = true;
		f.project.saveExecutionObject = async (mediaType, bytes) => {
			if (crash && mediaType === CHECKPOINT_MEDIA_TYPE) {
				const checkpoint = (await f.harness.checkpoints.read(bytes)) as { loop: LoopCheckpoint };
				if (checkpoint.loop.actions.some((action) => action.state === "result_ready")) {
					crash = false;
					throw new Error("process exited before the action result was saved");
				}
			}
			return save(mediaType, bytes);
		};
		f.provider.setResponses([call("probe", {}), reply("第二轮完成")]);
		f.project.queueInbox(id, "第二轮");
		assert.match((await turn(id, probe("v2"))).failure?.message ?? "", /process exited/);

		// 参数在半途变了：不能拿新参数去解释旧动作，要大声失败。
		const changed = await turn(
			id,
			probe("v2", Type.Object({ extra: Type.Optional(Type.String()) }, { additionalProperties: false })),
		);
		assert.equal(changed.session.status, "paused");
		assert.equal(changed.session.pause?.code, "binding_mismatch");

		const resumed = await turn(id, probe("v2"), { fromPaused: true });
		assert.equal(resumed.session.status, "idle", "第一轮的 v1 声明不该参与第二轮的恢复");
		assert.equal(resumed.value?.reply, "第二轮完成");
		assert.equal(f.provider.state.callCount, 3, "恢复不重新请求模型决定那个动作");
	} finally {
		await f.close();
	}
});

test("interrupt：打断的 turn 回 idle 不记故障；消息列表与候选文件保留，下一句接着跑", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		const controller = new AbortController();
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "真相公开须承担不可逆代价。" }),
			async () => {
				controller.abort(new Error("作者停止了当前回复"));
				return call("read", { path: "intent/计谋的代价.md" });
			},
		]);
		const outcome = await f.say("修改意图", id, { signal: controller.signal });
		assert.equal(outcome.session.status, "idle");
		assert.equal(outcome.failure, undefined);
		assert.equal(outcome.session.lastFailure, undefined);
		assert.equal(outcome.session.lease, undefined);
		assert.match(await f.checkoutFile("intent/计谋的代价.md"), /不可逆代价/);
		await assert.rejects(f.say("已打断的 signal 不能再开 turn", id, { signal: controller.signal }), {
			code: "run_interrupted",
		});
		f.provider.setResponses([
			async (context) => {
				const encoded = JSON.stringify(context.messages);
				assert.match(encoded, /计谋的代价\.md/, "打断前已确认的文件动作还在消息列表里");
				assert.match(encoded, /接着刚才的/);
				return reply("接着刚才的改动继续");
			},
		]);
		const next = await f.say("接着刚才的", id);
		assert.equal(next.failure, undefined);
	} finally {
		await f.close();
	}
});

test("interrupt：停止落在请求记为已发出、实际还没发出时，下一句照常回答并带上新消息", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		const controller = new AbortController();
		const save = f.project.saveExecutionObject.bind(f.project);
		f.project.saveExecutionObject = async (mediaType, bytes) => {
			const saved = await save(mediaType, bytes);
			if (mediaType === CHECKPOINT_MEDIA_TYPE) {
				const checkpoint = (await f.harness.checkpoints.read(bytes)) as { loop: LoopCheckpoint };
				if (checkpoint.loop.calls.at(-1)?.state === "effect_pending")
					controller.abort(new Error("作者停止了当前回复"));
			}
			return saved;
		};
		f.provider.setResponses([
			async (context) => {
				const encoded = JSON.stringify(context.messages);
				assert.match(encoded, /分析这个选择/, "停止前那句还在消息列表里");
				assert.match(encoded, /接着说/, "停止后的新消息进了这次请求");
				return reply("接着停下前的分析继续");
			},
		]);
		const stopped = await f.say("分析这个选择", id, { signal: controller.signal });
		assert.equal(stopped.session.status, "idle");
		assert.equal(stopped.failure, undefined);
		assert.equal(f.provider.state.callCount, 0, "停在发出之前，请求没有发生");
		const next = await f.say("接着说", id);
		assert.equal(next.session.status, "idle", "作者自己的停止不能变成「模型请求结果待确认」");
		assert.equal(next.value?.reply, "接着停下前的分析继续");
		assert.equal(f.provider.state.callCount, 1, "不先重发停下前那次没发出的请求");
	} finally {
		await f.close();
	}
});

test("进程重启：持有进程已死的 running session 收敛回 idle 记 process_restart，下一句从 checkpoint 续", async (t) => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([reply("第一轮回答")]);
		const apply = f.project.applyExecutionDelta.bind(f.project);
		let crash = true;
		t.mock.method(f.project, "applyExecutionDelta", (delta: ExecutionStateDelta) => {
			const session = delta.changed.find((item) => item.type === "session" && item.record.id === id)?.record as
				| SessionRecord
				| undefined;
			if (crash && session?.status === "idle" && session.turn === 1 && session.checkpointRef !== undefined) {
				crash = false;
				throw new Error("process exited before the turn settled");
			}
			apply(delta);
		});
		await assert.rejects(f.say("讨论作品", id), /process exited/);
		const stale = f.project.loadExecutionState().sessions.find((item) => item.id === id);
		assert.equal(stale?.status, "running");
		assert.ok(stale?.lease);
		// 另一个进程打开作品：持有者已经不在，才收敛。
		assert.deepEqual(f.project.createExecutionState().recoverUnfinished("test:alive", { holderAlive: () => true }), {
			recoveredSessionIds: [],
		});
		f.project.createExecutionState().recoverUnfinished("test:crash", { holderAlive: () => false });
		const recovered = f.harness.session(id);
		assert.equal(recovered.status, "idle");
		assert.equal(recovered.lastFailure?.code, "process_restart");
		assert.equal(recovered.lease, undefined);
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /第一轮回答/);
				return reply("接上了");
			},
		]);
		const next = await f.say("接着说", id);
		assert.equal(next.session.turn, 2);
		assert.equal(next.session.lastFailure, undefined);
		assert.equal(f.project.loadExecutionState().sessions.length, 1);
	} finally {
		await f.close();
	}
});

test("作者与 Agent 共用一份候选：作者未提交的修改随 Agent 的 commit 一起进版本，没有合并步骤", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "真相公开须承担不可逆代价。" }),
			reply("改好了，还没提交"),
		]);
		await f.say("完善创作意图", id);
		// 作者在编辑器里改了另一个文件，也没提交：checkout 里现在是两个人的改动，只有一份 diff。
		await writeFile(join(f.root, "world/places/赤壁.md"), "旧朝库房，入口新添了作者设计的双锁。\n");
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /候选里未提交的文件 2 个/, "附注按同一份候选算");
				return call("commit", { summary: "提交双方的改动" });
			},
			async (context) => {
				const result = context.messages.at(-1);
				const part = Array.isArray(result?.content) ? result.content[0] : undefined;
				assert.ok(part?.type === "text");
				// 作者那份改动不能静默进版本：提交结果如实列出这次进版本的每个文件。
				assert.deepEqual((JSON.parse(part.text) as { committed: string[] }).committed, [
					"intent/计谋的代价.md",
					"world/places/赤壁.md",
				]);
				return reply("双方修改都已保存，其中 world/places/赤壁.md 是你改的");
			},
		]);
		const outcome = await f.say("提交吧，保留我对库房的新设定", id);
		assert.equal(outcome.failure, undefined);
		assert.equal((await f.project.history()).length, 2, "一次提交，不是两次");
		const committed = await f.project.exportRevision();
		const text = (path: string) =>
			new TextDecoder().decode(committed.find((file) => file.path === path)?.bytes ?? new Uint8Array());
		assert.match(text("world/places/赤壁.md"), /双锁/);
		assert.match(text("intent/计谋的代价.md"), /不可逆/);
		assert.equal(outcome.session.baseRevisionId, f.project.project().headRevisionId);
	} finally {
		await f.close();
	}
});

test("作者在两个 turn 之间提交过：附注只在紧随其后的那个 turn 说「有新提交」", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([reply("先只讨论")]);
		await f.say("先聊聊", id);
		await writeFile(join(f.root, "world/places/赤壁.md"), "旧朝库房，入口新添了作者设计的双锁。\n");
		await f.project.commitCheckout();
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages.at(-1)), /上一轮之后作品有新提交/);
				return reply("看到你的新版本了");
			},
		]);
		await f.say("我提交了库房设定", id);
		f.provider.setResponses([
			async (context) => {
				assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /有新提交/, "同一条附注不重复说");
				return reply("继续");
			},
		]);
		await f.say("接着说", id);
	} finally {
		await f.close();
	}
});

test("作者与 Agent 改同一文件：edit 以 checkout 当前内容为准，对不上就失败让模型重读", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "Agent 候选：真相必须付出代价。\n" }),
			reply("改好了"),
		]);
		await f.say("完善意图", id);
		// 作者直接覆盖了同一个文件：Agent 记住的 oldText 已经不在文件里。
		await writeFile(join(f.root, "intent/计谋的代价.md"), "作者版本：不要放弃唯一证据。\n");
		f.provider.setResponses([
			call("edit", { path: "intent/计谋的代价.md", oldText: "Agent 候选：真相必须付出代价。", newText: "改写" }),
			async (context) => {
				assert.match(JSON.stringify(context.messages.at(-1)), /edit_not_unique/);
				return call("read", { path: "intent/计谋的代价.md" });
			},
			async (context) => {
				assert.match(JSON.stringify(context.messages.at(-1)), /作者版本/, "重读拿到的是作者的内容");
				return call("edit", {
					path: "intent/计谋的代价.md",
					oldText: "不要放弃唯一证据。",
					newText: "不要放弃唯一证据，公开它要付出代价。",
				});
			},
			call("commit", { summary: "在作者版本上继续" }),
			reply("已按你的版本改并提交"),
		]);
		const outcome = await f.say("继续改", id);
		assert.equal(outcome.failure, undefined);
		assert.match(await f.checkoutFile("intent/计谋的代价.md"), /作者版本：不要放弃唯一证据，公开它要付出代价。/);
		assert.equal((await f.project.history()).length, 2);
	} finally {
		await f.close();
	}
});

test("Context 压缩只改变下一次输入，原消息与动作在 checkpoint 里保留", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			call("read", { path: "intent/计谋的代价.md" }),
			call("compact_context", {
				summary: "目标是分析代价。已读 intent/计谋的代价.md；已有主动选择与不可逆代价要求，尚未修改或提交作品。",
			}),
			async (context) => {
				const encoded = JSON.stringify(context.messages);
				assert.match(encoded, /执行摘要/);
				assert.match(encoded, /仅分析代价，不修改作品/);
				assert.equal(
					context.messages.some((message) => message.role === "toolResult" && message.toolName === "read"),
					false,
				);
				return reply("现有设计已说明代价");
			},
		]);
		const outcome = await f.say("仅分析代价，不修改作品");
		assert.equal(outcome.failure, undefined);
		assert.equal(f.provider.state.callCount, 3);
		assert.equal((await f.project.history()).length, 1);
		const checkpointRef = outcome.session.checkpointRef ?? assert.fail("缺少 checkpoint");
		const checkpoint = (await f.harness.checkpoints.read(
			(
				await f.project.readExecutionObject(checkpointRef.id)
			).bytes,
		)) as {
			loop: LoopCheckpoint;
		};
		assert.ok(
			checkpoint.loop.messages.some((message) => message.role === "toolResult" && message.toolName === "read"),
		);
		assert.ok(checkpoint.loop.reduction?.modelCallId);
	} finally {
		await f.close();
	}
});

test("模型调用失败：turn 回 idle 记 lastFailure；已确认的文件动作保留，下一句接着提交", async () => {
	const f = await fixture();
	try {
		f.provider.setResponses([
			call("edit", { path: "intent/计谋的代价.md", oldText: "骗局的每一步", newText: "骗局的每一环" }),
			{ ...fauxAssistantMessage("模型服务失败"), stopReason: "error", errorMessage: "provider unavailable" },
		]);
		const failed = await f.say("把「每一步」改成「每一环」");
		assert.equal(failed.failure?.code, "model_call_failed");
		assert.equal(failed.session.status, "idle");
		assert.equal(failed.session.lastFailure?.retryable, true);
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /骗局的每一环/);
				return call("commit", { summary: "保存已完成的修改" });
			},
			reply("修改已提交"),
		]);
		const next = await f.say("继续", failed.sessionId);
		assert.equal(next.failure, undefined);
		assert.equal((await f.project.history()).length, 2);
		assert.equal(next.session.usage?.calls, 4);
	} finally {
		await f.close();
	}
});

test("turn 开始时读取作品失败：回 idle 记一句并释放 lease，下一句直接重试", async () => {
	const f = await fixture();
	try {
		const historyReader = f.project.historyReader.bind(f.project);
		let fail = true;
		f.project.historyReader = () => {
			if (fail) {
				fail = false;
				throw new Error("injected session read failure");
			}
			return historyReader();
		};
		const failed = await f.say("讨论作品");
		assert.match(failed.failure?.message ?? "", /injected/);
		assert.equal(failed.session.status, "idle");
		assert.equal(failed.session.lease, undefined);
		f.provider.setResponses([
			async (context) => {
				assert.match(JSON.stringify(context.messages), /讨论作品/, "上一次没跑成的消息还在 inbox 里");
				return reply("恢复后回答");
			},
		]);
		const next = await f.say(undefined, failed.sessionId);
		assert.equal(next.value?.reply, "恢复后回答");
		assert.equal(f.project.loadExecutionState().sessions.length, 1);
	} finally {
		await f.close();
	}
});

test("续跑时读取权威状态失败也释放 lease，并保留 checkout 里的候选文件", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "保留作者代价要求" }),
			reply("改好了"),
		]);
		await f.say("修订意图", id);
		const before = await f.checkoutFile("intent/计谋的代价.md");
		const exportRevision = f.project.exportRevision.bind(f.project);
		f.project.exportRevision = async () => {
			throw new Error("injected export failure");
		};
		const failed = await f.say("继续", id);
		f.project.exportRevision = exportRevision;
		assert.match(failed.failure?.message ?? "", /injected export failure/);
		assert.equal(failed.session.status, "idle");
		assert.equal(failed.session.lease, undefined);
		assert.equal(await f.checkoutFile("intent/计谋的代价.md"), before);
	} finally {
		await f.close();
	}
});

test("session_running：同一 session 不能并发开两个 turn", async () => {
	const f = await fixture();
	try {
		const id = (await f.harness.createSession()).id;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.provider.setResponses([
			async () => {
				await gate;
				return reply("第一个 turn 的回答");
			},
		]);
		const first = f.say("第一句", id);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await assert.rejects(f.say(undefined, id), (error: unknown) => {
			return error instanceof SuimingHarnessError && error.code === "session_running";
		});
		release();
		const outcome = await first;
		assert.equal(outcome.value?.reply, "第一个 turn 的回答");
	} finally {
		await f.close();
	}
});

test("委派观测归属 turn；工具 / Checker 带同一 session 关联", async () => {
	const { InMemorySpanExporter, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace");
	const { createOpenTelemetry } = await import("../src/index.js");
	const exporter = new InMemorySpanExporter();
	const telemetry = createOpenTelemetry({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
	const f = await fixture({ telemetryContext: telemetry.context });
	try {
		f.provider.setResponses([
			call("write", { path: "intent/计谋的代价.md", content: "每次选择都有不可逆的代价。" }),
			call("review", { layer: "design", goal: "检查代价" }),
			call("submit_review", { verdict: "pass", summary: "通过", findings: [], uncovered: [], uncertainties: [] }),
			call("commit", { summary: "采用候选" }),
			reply("完成"),
		]);
		const outcome = await f.say("观测回归");
		const spans = exporter.getFinishedSpans();
		const turn = spans.find((s) => s.name === "suiming.turn agent");
		const review = spans.find((s) => s.name === "suiming.task review");
		assert.ok(turn);
		assert.equal(review?.parentSpanContext?.spanId, turn.spanContext().spanId);
		assert.equal(turn.attributes["suiming.turn.id"], outcome.session.turnId);
		for (const span of spans) assert.equal(span.attributes["langfuse.session.id"], outcome.sessionId, span.name);
		for (const name of ["suiming.checker.commit", "suiming.tool write", "suiming.tool review"])
			assert.ok(
				spans.some((s) => s.name === name),
				name,
			);
	} finally {
		await f.close();
		await telemetry.shutdown();
	}
});
