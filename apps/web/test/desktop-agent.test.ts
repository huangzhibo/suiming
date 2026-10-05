import assert from "node:assert/strict";
import test from "node:test";
import { type AGUIEvent, EventType } from "@suiming/sdk";
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

/** 按 Runtime 的 attach 实际给出的形状：先是包在最近一次运行里的快照，再是之后的增量（productEventSnapshot）。 */
const attached: AGUIEvent[] = [
	run("t1"),
	{
		type: EventType.MESSAGES_SNAPSHOT,
		messages: [
			{ id: "m1", role: "user", content: "第一句", metadata: { suiming: { sequence: 2 } } },
			{ id: "m2", role: "assistant", content: "第一轮回答", metadata: { suiming: { sequence: 4 } } },
		],
	},
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
	{ type: EventType.SUBAGENT_STARTED, subagentRunId: "task-1", name: "subagent" },
	...text("w1", "assistant", "子任务的话", "task-1"),
	{ type: EventType.SUBAGENT_FINISHED, subagentRunId: "task-1", outcome: { type: "success" } },
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
	{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m4", delta: "一半" },
];

async function* stream(events: readonly AGUIEvent[]) {
	for (const event of events) yield event;
}

test("对话交给 AG-UI 官方客户端拼：attach 快照加之后的增量，消息按 id 拼好，正在生成跟着运行的开始与结束", async () => {
	// 2026-10-05 之前用 TanStack AI 的 useChat：它内嵌另一份 @ag-ui/core（0.1.1-canary），bridge 靠一次类型强转把两边接起来，
	// send 抛错、isLoading 恒为 false，只用到拼消息。
	const agent = new DesktopAgent("s", () => stream(attached));
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
	assert.deepEqual(generating, [true, false, true], "第二次运行还没结束");
	assert.deepEqual(
		conversationMessages(agent.messages).map((message) => [message.id, message.role, message.text]),
		[
			["m1", "user", "第一句"],
			["m2", "assistant", "第一轮回答"],
			["m3", "user", "第二句"],
			["m4", "assistant", "流到一半"],
		],
		"动作快照与子任务的话不进对话；流到一半的那条照样拼出来",
	);
	assert.equal(conversationMessages(agent.messages)[0]?.sequence, 2, "快照里的持久序号随消息带着");
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
