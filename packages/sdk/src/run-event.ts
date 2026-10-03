import { type AGUIEvent, EventSchemas, EventType } from "@ag-ui/core";
import { type Static, type TSchema, type TUnsafe, Type } from "typebox";
import { Value } from "typebox/value";
import { zodToJsonSchema } from "zod-to-json-schema";
import { executionFailureSchema, modelUsageSchema } from "./domain-schema.js";

export type { AGUIEvent } from "@ag-ui/core";
export { EventType } from "@ag-ui/core";

const nonempty = Type.String({ minLength: 1 });

/** 标准字段直接来自上游；TypeBox 仅组合传输信封与 Suiming 扩展。 */
export const ProductEventSchema: TUnsafe<AGUIEvent> = Type.Unsafe<AGUIEvent>(
	zodToJsonSchema(EventSchemas as unknown as Parameters<typeof zodToJsonSchema>[0], {
		$refStrategy: "none",
	}) as TSchema,
);
/** `suiming.session`：session 状态的确认点投影。AG-UI 的 threadId 是 sessionId，runId 是 turn id。 */
export const SuimingSessionNoticeSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("paused")]),
		version: Type.Integer({ minimum: 1 }),
		turn: Type.Integer({ minimum: 0 }),
		pause: Type.Optional(executionFailureSchema),
		lastFailure: Type.Optional(executionFailureSchema),
		usage: Type.Optional(modelUsageSchema),
	},
	{ additionalProperties: false },
);
export const SuimingActivitySchema = Type.Object(
	{
		taskId: nonempty,
		label: nonempty,
		status: Type.Union([
			Type.Literal("running"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("interrupted"),
		]),
		summary: Type.Optional(Type.String()),
		target: Type.Optional(Type.String()),
		resultObjectId: Type.Optional(nonempty),
		isError: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const TurnChangeSchema = Type.Object(
	{ count: Type.Integer({ minimum: 0 }), paths: Type.Array(nonempty, { maxItems: 20 }) },
	{ additionalProperties: false },
);
/**
 * `suiming.turn`：turn 结束时的对账，纯算术，进事件不进 prompt。作者说了几条、这一轮意图 / Design / 正文 /
 * 审稿 / 其它各改了哪些文件、Agent 提交了几个版本、checkout 里还有几个文件没提交。「作者目标是否达成」
 * 不在这里——那由作者看作品定（AGENTS.md「能力交给模型，可见性交给系统」）。路径每类最多 20 条，count 是全数。
 */
export const SuimingTurnSummarySchema = Type.Object(
	{
		authorMessages: Type.Integer({ minimum: 0 }),
		changed: Type.Object(
			{
				intent: TurnChangeSchema,
				design: TurnChangeSchema,
				text: TurnChangeSchema,
				review: TurnChangeSchema,
				other: TurnChangeSchema,
			},
			{ additionalProperties: false },
		),
		revisions: Type.Integer({ minimum: 0 }),
		uncommitted: Type.Integer({ minimum: 0 }),
		/** 这一轮没取写作依据（write_context / 委派 writer）就整篇写入的正文；2026-10-03 加，更早的事件没有它。 */
		textWithoutContext: Type.Optional(TurnChangeSchema),
	},
	{ additionalProperties: false },
);
export type SuimingTurnSummary = Static<typeof SuimingTurnSummarySchema>;
/** 持久事件信封：sessionId 是持久身份，event.runId（turn id）只在 AG-UI 生命周期事件里出现。 */
export interface SessionEvent {
	sessionId: string;
	id: string;
	sequence: number;
	at: string;
	event: AGUIEvent;
}
export const SessionEventSchema: TUnsafe<SessionEvent> = Type.Unsafe<SessionEvent>(
	Type.Object(
		{
			sessionId: nonempty,
			id: nonempty,
			sequence: Type.Integer({ minimum: 1 }),
			at: nonempty,
			event: ProductEventSchema,
		},
		{ additionalProperties: false },
	),
);
export type SessionEventBody = AGUIEvent;
export type SessionEventType = AGUIEvent["type"];
export type SessionEventListener = (event: SessionEvent) => void;

export function validateProductEvent(event: AGUIEvent): void {
	EventSchemas.parse(event);
	if (event.type === EventType.CUSTOM) {
		if (event.name !== "suiming.session" || !Value.Check(SuimingSessionNoticeSchema, event.value))
			throw new TypeError(`Invalid Suiming event ${event.name}`);
	}
	if (event.type === EventType.ACTIVITY_SNAPSHOT && event.activityType.startsWith("suiming.")) {
		const schema =
			event.activityType === "suiming.turn"
				? SuimingTurnSummarySchema
				: ["suiming.task", "suiming.action"].includes(event.activityType)
					? SuimingActivitySchema
					: undefined;
		if (schema === undefined || !Value.Check(schema, event.content))
			throw new TypeError(`Invalid Suiming activity ${event.activityType}`);
	}
}

export type { Message as AGUIMessage } from "@ag-ui/core";
