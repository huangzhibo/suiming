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
 *
 * 子任务是 AG-UI 的 subagent，`subagentRunId` 就是 task id：开始跑（新建或续跑）发 SUBAGENT_STARTED，
 * 完成发 SUBAGENT_FINISHED（success），失败发 SUBAGENT_ERROR，打断或停在用量检查点发 SUBAGENT_FINISHED（suspended），
 * 下一轮续跑时以同一个 id 再发 SUBAGENT_STARTED。官方客户端要求 RUN_FINISHED 之前子任务都已结束，所以同一次确认里
 * 子任务的事件排在这个 session 的 RUN_FINISHED 之前。2026-10-05 之前另发一份自定义的 `suiming.task` 活动，
 * 而且排在 RUN_FINISHED 之后。
 */
export function executionProductEvents(before: ExecutionEntities, after: ExecutionEntities): ConfirmedStateEvent[] {
	const events: ConfirmedStateEvent[] = [];
	const previousSessions = new Map(before.sessions.map((session) => [session.id, session]));
	const previousTasks = new Map(before.tasks.map((task) => [task.id, task]));
	const taskEvents = new Map<string, ConfirmedStateEvent[]>();
	for (const task of after.tasks) {
		const previous = previousTasks.get(task.id);
		if (previous?.version === task.version || previous?.status === task.status) continue;
		const event = subagentEvent(task, previous?.status);
		if (event === undefined) continue;
		const list = taskEvents.get(task.sessionId) ?? [];
		list.push({ sessionId: task.sessionId, id: `${task.id}:state:${task.version}`, event });
		taskEvents.set(task.sessionId, list);
	}
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
		events.push(...(taskEvents.get(session.id) ?? []));
		taskEvents.delete(session.id);
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
	// session 这次没变（子任务在一轮中间开始或结束）的，跟在后面
	for (const list of taskEvents.values()) events.push(...list);
	for (const record of events) validateProductEvent(record.event);
	return events;
}

/** 子任务状态的一次变化对应的 AG-UI subagent 事件；没有对应的（如 interrupted 之间）不发。 */
function subagentEvent(
	task: ExecutionEntities["tasks"][number],
	previous: ExecutionEntities["tasks"][number]["status"] | undefined,
): SessionEventBody | undefined {
	const subagentRunId = task.id;
	if (task.status === "running") return { type: EventType.SUBAGENT_STARTED, subagentRunId, name: task.kind };
	if (previous !== "running") return undefined;
	if (task.status === "completed")
		return { type: EventType.SUBAGENT_FINISHED, subagentRunId, outcome: { type: "success" } };
	if (task.status === "interrupted")
		return { type: EventType.SUBAGENT_FINISHED, subagentRunId, outcome: { type: "suspended" } };
	return {
		type: EventType.SUBAGENT_ERROR,
		subagentRunId,
		message: task.failure?.message ?? "子任务失败",
		...(task.failure === undefined ? {} : { code: task.failure.code }),
	};
}
