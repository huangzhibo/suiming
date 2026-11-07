import assert from "node:assert/strict";
import test from "node:test";
import { productEventSnapshot } from "@suiming/runtime";
import { type AGUIEvent, EventType, type SessionEvent } from "@suiming/sdk";
import { conversationMessages, DesktopAgent } from "../src/desktop-agent.js";

const run = (runId: string): AGUIEvent => ({ type: EventType.RUN_STARTED, threadId: "s", runId });
const finished = (runId: string): AGUIEvent => ({
	type: EventType.RUN_FINISHED,
	threadId: "s",
	runId,
	outcome: { type: "success" },
});
const text = (messageId: string, role: "user" | "assistant", delta: string, subagentRunId?: string): AGUIEvent[] => {
	const origin = subagentRunId === undefined ? {} : { subagentRunId };
	return [
		{ type: EventType.TEXT_MESSAGE_START, messageId, role, metadata: { suiming: { sessionId: "s" } }, ...origin },
		{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, ...origin },
		{ type: EventType.TEXT_MESSAGE_END, messageId, ...origin },
	];
};

const history: AGUIEvent[] = [
	run("t1"),
	...text("m1", "user", "第一句"),
	...text("m2", "assistant", "第一轮回答"),
	{
		type: EventType.ACTIVITY_SNAPSHOT,
		messageId: "a1",
		activityType: "suiming.action",
		content: { label: "read", status: "completed" },
	},
	{ type: EventType.CUSTOM, name: "suiming.session", value: { status: "idle", version: 3, turn: 1 } },
	finished("t1"),
	run("t2"),
	...text("m3", "user", "第二句"),
	{ type: EventType.SUBAGENT_STARTED, subagentRunId: "task-1", name: "writer" },
	...text("w1", "assistant", "子任务的话", "task-1"),
	// 2026-10-05 之前落盘的子任务消息没有 subagentRunId，靠 metadata.suiming.taskKind 认
	{
		type: EventType.TEXT_MESSAGE_START,
		messageId: "w0",
		role: "assistant",
		metadata: { suiming: { taskKind: "review" } },
	},
	{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "w0", delta: "旧事件里审稿的话" },
	{ type: EventType.TEXT_MESSAGE_END, messageId: "w0" },
	{
		type: EventType.TEXT_MESSAGE_START,
		messageId: "m4",
		role: "assistant",
		metadata: { suiming: { sessionId: "s" } },
	},
	{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m4", delta: "流到" },
];

async function* stream(events: readonly AGUIEvent[]) {
	for (const event of events) yield event;
}

test("完整回放与 Runtime 快照加增量保留消息、顺序与序号，续接半截输出和子任务", async () => {
	const durable = history.map(
		(event, i): SessionEvent => ({ sessionId: "s", id: `e${i}`, sequence: i + 1, at: "2026-11-07", event }),
	);
	const original = structuredClone(durable);
	const delta: AGUIEvent[] = [
		{ type: EventType.SUBAGENT_FINISHED, subagentRunId: "task-1", outcome: { type: "success" } },
		{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m4", delta: "一半" },
		{ type: EventType.TEXT_MESSAGE_END, messageId: "m4" },
		finished("t2"),
	];
	const order = new Map(
		durable.flatMap(({ event, sequence }) =>
			event.type === EventType.TEXT_MESSAGE_START ? [[event.messageId, sequence] as const] : [],
		),
	);
	async function replay(events: AGUIEvent[], lifecycle: boolean[]) {
		const agent = new DesktopAgent("s", () => stream(events));
		const generating: boolean[] = [];
		agent.subscribe({
			onRunStartedEvent: () => {
				generating.push(true);
			},
			onRunFinishedEvent: () => {
				generating.push(false);
			},
		});
		await agent.connectAgent();
		assert.equal(agent.threadId, "s");
		assert.deepEqual(generating, lifecycle);
		return conversationMessages(agent.messages);
	}
	const full = await replay([...durable.map(({ event }) => event), ...delta], [true, false, true, false]);
	const restored = await replay([...productEventSnapshot(durable), ...delta], [true, false]);
	assert.deepEqual(
		full.map(({ id, role, text }) => [id, role, text]),
		[
			["m1", "user", "第一句"],
			["m2", "assistant", "第一轮回答"],
			["m3", "user", "第二句"],
			["m4", "assistant", "流到一半"],
		],
	);
	// 完整日志的序号由 bridge 从 TEXT_MESSAGE_START 记录，快照则随消息携带。
	assert.deepEqual(
		restored,
		full.map((message) => ({ ...message, sequence: order.get(message.id) })),
	);
	assert.deepEqual(durable, original);
});

test("单事件校验预算允许边界快照，超限时终止连接而不截断消息", async () => {
	const agentFor = (length: number) => {
		const agent = new DesktopAgent("s", () =>
			stream([
				run("t1"),
				{
					type: EventType.MESSAGES_SNAPSHOT,
					messages: Array.from({ length }, (_, i) => ({ id: `m${i}`, role: "assistant", content: "正文" })),
				},
				finished("t1"),
			]),
		);
		// 事件自身 2 个键，数组每个元素和消息的 3 个键各计一项。
		agent.maxEnforcedEntries = 10;
		return agent;
	};
	const accepted = agentFor(2);
	await accepted.connectAgent();
	assert.equal(accepted.messages.length, 2);
	const rejected = agentFor(3);
	await assert.rejects(rejected.connectAgent(), { name: "AGUIEnforcementLimitError" });
	assert.deepEqual(rejected.messages, []);
});

test("动作快照由对话视图单独展示，官方客户端只拼消息", async () => {
	const actions = Array.from(
		{ length: 3 },
		(_, index): AGUIEvent => ({
			type: EventType.ACTIVITY_SNAPSHOT,
			messageId: `a${index}`,
			activityType: "suiming.action",
			content: { label: "read", status: "completed" },
		}),
	);
	const agent = new DesktopAgent("s", () =>
		stream([run("t1"), ...actions, ...text("m1", "assistant", "好"), finished("t1")]),
	);
	await agent.connectAgent();
	assert.deepEqual(
		agent.messages.map((message) => [message.id, message.role]),
		[["m1", "assistant"]],
	);
});

test("落在运行之外的事件会让官方客户端整条流报错：Runtime 那边由 run-event-stream 的生命周期测试守着", async () => {
	// 换客户端前查到 Runtime 唯一一处不符：新建 session 的 suiming.session 通知落在任何一次运行之前。
	const outside: AGUIEvent = {
		type: EventType.CUSTOM,
		name: "suiming.session",
		value: { status: "idle", version: 1, turn: 0 },
	};
	const failures: string[] = [];
	const agent = new DesktopAgent("s", () => stream([outside, run("t1")]));
	agent.subscribe({
		onRunFailed: ({ error }) => {
			failures.push(error.message);
		},
	});
	await agent.connectAgent().catch((error: Error) => failures.push(error.message));
	assert.ok(
		failures.some((message) => /RUN_STARTED/u.test(message)),
		failures.join("\n"),
	);
});
