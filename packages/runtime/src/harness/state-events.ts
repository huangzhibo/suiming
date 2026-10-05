import { EventType, type SessionEventBody, validateProductEvent } from "@suiming/sdk";
import type { ExecutionEntities } from "../execution/types.js";

export interface ConfirmedStateEvent {
	sessionId: string;
	id: string;
	event: SessionEventBody;
}

/**
 * 纯投影；由持久 adapter 将状态与这些事件在同一事务确认。
 *
 * AG-UI 的 threadId 是 sessionId，runId 是 turn id：一个 turn 一对 RUN_STARTED / RUN_FINISHED。
 * 模型停下回 idle 是 success；进 paused 是 interrupt，reason 带 pause 的错误码。
 * 每个事件都落在某次运行之内：AG-UI 的官方客户端按运行生命周期校验整条流（第一条必须是 RUN_STARTED，
 * RUN_FINISHED 之后只能接下一次 RUN_STARTED）。所以 `suiming.session` 只在运行中与运行收尾时发；
 * 新建 session 这类运行之外的变化不发，session 列表本来就走查询。
 */
export function executionProductEvents(before: ExecutionEntities, after: ExecutionEntities): ConfirmedStateEvent[] {
	const events: ConfirmedStateEvent[] = [];
	const previousSessions = new Map(before.sessions.map((session) => [session.id, session]));
	const previousTasks = new Map(before.tasks.map((task) => [task.id, task]));
	for (const session of after.sessions) {
		const previous = previousSessions.get(session.id);
		if (previous?.version === session.version) continue;
		const turnId = session.turnId;
		const metadata = { suiming: { sessionId: session.id } };
		if (turnId !== undefined && previous?.turnId !== turnId)
			events.push({
				sessionId: session.id,
				id: `${turnId}:started`,
				event: { type: EventType.RUN_STARTED, threadId: session.id, runId: turnId, metadata },
			});
		if (session.status === "running" || previous?.status === "running")
			events.push({
				sessionId: session.id,
				id: `${session.id}:state:${session.version}`,
				event: {
					type: EventType.CUSTOM,
					name: "suiming.session",
					value: {
						status: session.status,
						version: session.version,
						turn: session.turn,
						...(session.pause === undefined ? {} : { pause: session.pause }),
						...(session.lastFailure === undefined ? {} : { lastFailure: session.lastFailure }),
						...(session.usage === undefined ? {} : { usage: session.usage }),
					},
				},
			});
		if (turnId !== undefined && previous?.status === "running" && session.status !== "running") {
			events.push({
				sessionId: session.id,
				id: `${turnId}:finished`,
				event:
					session.status === "idle"
						? {
								type: EventType.RUN_FINISHED,
								threadId: session.id,
								runId: turnId,
								outcome: { type: "success" },
								...(session.lastFailure === undefined ? {} : { result: session.lastFailure }),
								metadata,
							}
						: {
								type: EventType.RUN_FINISHED,
								threadId: session.id,
								runId: turnId,
								outcome: {
									type: "interrupt",
									interrupts: [
										{
											id: `${turnId}:pause`,
											reason: session.pause?.code ?? "paused",
											message: session.pause?.message ?? "需要作者处理",
										},
									],
								},
								metadata,
							},
			});
		}
	}
	for (const task of after.tasks) {
		if (previousTasks.get(task.id)?.version === task.version) continue;
		events.push({
			sessionId: task.sessionId,
			id: `${task.id}:state:${task.version}`,
			event: {
				type: EventType.ACTIVITY_SNAPSHOT,
				messageId: task.id,
				activityType: "suiming.task",
				replace: true,
				content: {
					taskId: task.id,
					label: task.kind,
					status: task.status,
					...(task.result ? { resultObjectId: task.result.id } : {}),
				},
				metadata: { suiming: { sessionId: task.sessionId, taskId: task.id, taskKind: task.kind } },
			},
		});
	}
	for (const record of events) validateProductEvent(record.event);
	return events;
}
