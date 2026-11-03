import assert from "node:assert/strict";
import test from "node:test";
import { EventSchemas } from "@ag-ui/core/schemas";
import { Value } from "typebox/value";
import { z } from "zod/v4";
import { EventType, validateProductEvent } from "../src/index.js";
import { ProductEventSchema, SessionEventSchema } from "../src/run-event.js";

test("AG-UI schema 转成传输 schema 后，保留消息、工具、快照的必填字段和嵌套类型约束", () => {
	const cases: [string, unknown, boolean][] = [
		["文本增量", { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "正文" }, true],
		["缺少消息 id", { type: "TEXT_MESSAGE_CONTENT", delta: "正文" }, false],
		["增量不能是数字", { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: 1 }, false],
		["工具结果", { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "t", content: "结果" }, true],
		["工具结果不能缺调用 id", { type: "TOOL_CALL_RESULT", messageId: "m", content: "结果" }, false],
		["消息快照", { type: "MESSAGES_SNAPSHOT", messages: [{ id: "m", role: "assistant", content: "正文" }] }, true],
		["快照内消息必须有 id", { type: "MESSAGES_SNAPSHOT", messages: [{ role: "assistant", content: "正文" }] }, false],
		["快照必须是数组", { type: "MESSAGES_SNAPSHOT", messages: {} }, false],
		["运行结束", { type: "RUN_FINISHED", threadId: "s", runId: "r", outcome: { type: "success" } }, true],
		["未知事件", { type: "UNKNOWN_EVENT" }, false],
	];
	for (const [label, event, valid] of cases) {
		assert.equal(EventSchemas.safeParse(event).success, valid, `${label}：上游校验`);
		assert.equal(Value.Check(ProductEventSchema, event), valid, `${label}：转换后的校验`);
		assert.equal(
			Value.Check(SessionEventSchema, { sessionId: "s", id: "e", sequence: 1, at: "2026-11-03", event }),
			valid,
			`${label}：传输信封校验`,
		);
	}
});

test("超过长度上限的集合先拒绝，不逐项执行 Zod 校验", () => {
	// GHSA-mrhx-c7xc-m3w5：用很小的输入验证提前拒绝，避免测试本身消耗大量内存。
	let visits = 0;
	const schema = z
		.array(
			z.string().transform((value) => {
				visits++;
				return value;
			}),
		)
		.max(2);
	assert.equal(schema.safeParse(["一", "二", "三"]).success, false);
	assert.equal(visits, 0);
	assert.deepEqual(schema.parse(["一", "二"]), ["一", "二"]);
	assert.equal(visits, 2);
});

const none = { count: 0, paths: [] };
const turn = (content: unknown) => ({
	type: EventType.ACTIVITY_SNAPSHOT,
	messageId: "turn-1:summary",
	activityType: "suiming.turn",
	replace: true,
	content,
});

test("suiming.turn：turn 结束对账按 schema 校验，多一个字段或少一类都拒绝", () => {
	const valid = {
		authorMessages: 2,
		changed: {
			intent: { count: 1, paths: ["intent/计谋的代价.md"] },
			design: none,
			text: none,
			review: none,
			other: none,
		},
		revisions: 1,
		uncommitted: 0,
	};
	assert.doesNotThrow(() => validateProductEvent(turn(valid) as Parameters<typeof validateProductEvent>[0]));
	assert.throws(
		() => validateProductEvent(turn({ ...valid, verdict: "done" }) as Parameters<typeof validateProductEvent>[0]),
		/suiming\.turn/u,
	);
	const { review: _review, ...missing } = valid.changed;
	assert.throws(
		() => validateProductEvent(turn({ ...valid, changed: missing }) as Parameters<typeof validateProductEvent>[0]),
		/suiming\.turn/u,
	);
	assert.throws(
		() =>
			validateProductEvent({
				...turn(valid),
				activityType: "suiming.unknown",
			} as Parameters<typeof validateProductEvent>[0]),
		/suiming\.unknown/u,
	);
});
