import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type SessionEventBody } from "@suiming/sdk";
import { agentTurn } from "../src/harness/agent.js";
import { productEventSnapshot } from "../src/harness/event-snapshot.js";
import { SessionEventStream } from "../src/harness/events.js";
import { SuimingHarness } from "../src/index.js";
import { fauxGateway, reply, withSampleProject } from "./harness-fixtures.js";

/** AG-UI 的运行生命周期：头一条是 RUN_STARTED，每个事件都落在某次运行之内，RUN_FINISHED 之后只能接下一次 RUN_STARTED。 */
function assertRunLifecycle(events: readonly SessionEventBody[]) {
	let active = false;
	events.forEach((event, index) => {
		if (event.type === EventType.RUN_STARTED) {
			assert.equal(active, false, `#${index} RUN_STARTED：上一次运行还没结束`);
			active = true;
			return;
		}
		assert.equal(active, true, `#${index} ${event.type} 落在运行之外`);
		if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) active = false;
	});
}

test("一个对话的持久事件与 attach 快照都符合 AG-UI 的运行生命周期", async () => {
	// AG-UI 1.0 的官方客户端按这条校验（verifyEvents），不符合就整条流报错。2026-10-05 换掉 TanStack AI 之前查到
	// 唯一一处不符：新建 session 的第一条 suiming.session 通知落在任何一次运行之前；快照在没跑过时也以消息快照开头。
	await withSampleProject(async (project) => {
		const harness = new SuimingHarness({
			project,
			models: fauxGateway("lifecycle", [reply("第一轮"), reply("第二轮")], { main: "m", reviewer: "m" }),
		});
		const session = await harness.createSession();
		assert.deepEqual(project.readSessionEvents(session.id), [], "新建对话不发事件：还没有运行");
		assert.deepEqual(productEventSnapshot(project.readSessionEvents(session.id)), [], "没跑过的对话没有可重放的");
		project.queueInbox(session.id, "第一句");
		await harness.turn(session.id, {}, (handle) => agentTurn(handle));
		project.queueInbox(session.id, "第二句");
		await harness.turn(session.id, {}, (handle) => agentTurn(handle));
		const events = project.readSessionEvents(session.id);
		assertRunLifecycle(events.map((record) => record.event));
		assert.equal(events.filter((record) => record.event.type === EventType.RUN_STARTED).length, 2);
		assertRunLifecycle(productEventSnapshot(events));
		assertRunLifecycle(productEventSnapshot(events.slice(0, 5)));
	});
});

test("恢复对话保留消息与工具的原始次序，工具更新不移到末尾，也不修改持久事件", () => {
	const events = new SessionEventStream("session");
	events.emit({ type: EventType.RUN_STARTED, threadId: "session", runId: "turn-1" });
	events.message("first", "先说明", true, { suiming: { taskKind: "agent" } });
	events.emit({
		type: EventType.ACTIVITY_SNAPSHOT,
		messageId: "action",
		activityType: "suiming.action",
		replace: true,
		content: { label: "read", status: "running" },
	});
	events.message("second", "补充要求", true, { suiming: { taskKind: "agent", inboxSequence: 1 } }, "user");
	events.emit({
		type: EventType.ACTIVITY_SNAPSHOT,
		messageId: "action",
		activityType: "suiming.action",
		replace: true,
		content: { label: "read", status: "completed" },
	});
	const durable = events.durableEventsAfter(0);
	const original = structuredClone(durable);
	const snapshot = productEventSnapshot(durable);
	const messages = snapshot.find((event) => event.type === "MESSAGES_SNAPSHOT");
	assert.equal(messages?.type, "MESSAGES_SNAPSHOT");
	if (messages?.type !== "MESSAGES_SNAPSHOT") assert.fail("缺少消息快照");
	const action = snapshot.find((event) => event.type === "ACTIVITY_SNAPSHOT");
	assert.equal(action?.type, "ACTIVITY_SNAPSHOT");
	if (action?.type !== "ACTIVITY_SNAPSHOT") assert.fail("缺少动作快照");
	assert.deepEqual(
		messages.messages.map((message) => message.metadata?.suiming?.sequence),
		[2, 6],
	);
	assert.equal(action.metadata?.suiming?.sequence, 5);
	assert.equal(action.content.status, "completed");
	assert.equal(messages.messages[1]?.metadata?.suiming?.inboxSequence, 1);
	assert.deepEqual(durable, original);
});

test("事件先保存再发布；UI 监听器失败和修改不污染事件", () => {
	const order: string[] = [];
	const events = new SessionEventStream("session", undefined, {
		persist: () => {
			order.push("saved");
		},
	});
	events.subscribe((event) => {
		event.sequence = 999;
		throw new Error("window closed");
	});
	events.subscribe((event) => {
		order.push(`published:${event.sequence}`);
	});
	events.emit({ type: EventType.RUN_STARTED, runId: "interaction", threadId: "conversation" });
	assert.deepEqual(order, ["saved", "published:1"]);
	assert.equal(events.durableEventsAfter(0)[0]?.sequence, 1);
});

test("事件保存失败后不发布、不给后续事件放行", () => {
	const failure = new Error("database unavailable");
	let writes = 0;
	let notifications = 0;
	const events = new SessionEventStream("session", undefined, {
		persist: () => {
			writes += 1;
			throw failure;
		},
	});
	events.subscribe(() => {
		notifications += 1;
	});
	assert.throws(
		() => events.emit({ type: EventType.RUN_STARTED, runId: "interaction", threadId: "conversation" }),
		(error) => error === failure,
	);
	assert.throws(
		() => events.emit({ type: EventType.RUN_STARTED, runId: "different", threadId: "conversation" }),
		(error) => error === failure,
	);
	assert.deepEqual(events.durableEventsAfter(0), []);
	assert.equal(writes, 1);
	assert.equal(notifications, 0);
});

test("合批消息先保存，恢复用完整响应补齐尾部并按 id 去重", () => {
	const persisted: import("@suiming/sdk").SessionEvent[] = [];
	const events = new SessionEventStream("session", undefined, { persist: (event) => persisted.push(event) });
	events.appendText("message", "第一段".repeat(200), {});
	assert.equal(persisted.length, 2);
	const restored = new SessionEventStream("session", undefined, {
		history: persisted,
		persist: (event) => persisted.push(event),
	});
	restored.message("message", `${"第一段".repeat(200)}尾部`, true, {});
	const count = persisted.length;
	restored.message("message", `${"第一段".repeat(200)}尾部`, true, {});
	assert.equal(persisted.length, count);
	assert.equal(persisted.at(-1)?.event.type, EventType.TEXT_MESSAGE_END);
	assert.equal(restored.messageText("message"), `${"第一段".repeat(200)}尾部`);
});
