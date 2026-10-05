import type { AGUIMessage as Message } from "@suiming/sdk";
import { EventType, type SessionEvent, type SessionEventBody } from "@suiming/sdk";
/**
 * 查询持久事件的一次读取结果，不存第二份聊天状态，不产生执行命令。快照包在最近一次运行里（它的 RUN_STARTED 打头，
 * 结束了就以它的 RUN_FINISHED 收尾），符合 AG-UI 的运行生命周期；还没跑过的对话没有消息，返回空。运行还没结束时，
 * 这次运行里还在跑的子任务补上它们的 SUBAGENT_STARTED：之后的增量会有它们的结束事件，官方客户端要先见过开始。
 */
export function productEventSnapshot(events: readonly SessionEvent[]): SessionEventBody[] {
	const messages = new Map<string, Message>();
	const open = new Set<string>();
	const views = new Map<string, SessionEventBody>();
	const lifecycle: SessionEventBody[] = [];
	const subagents = new Map<string, SessionEventBody>();
	for (const { event, sequence } of events) {
		if (event.type === "TEXT_MESSAGE_START") {
			messages.set(event.messageId, {
				id: event.messageId,
				role: event.role,
				content: "",
				metadata: { ...event.metadata, suiming: { ...event.metadata?.suiming, sequence } },
				...(event.subagentRunId === undefined ? {} : { subagentRunId: event.subagentRunId }),
			} as Message);
			open.add(event.messageId);
		} else if (event.type === "TEXT_MESSAGE_CONTENT") {
			const message = messages.get(event.messageId);
			if (message && typeof message.content === "string") message.content += event.delta;
		} else if (event.type === "TEXT_MESSAGE_END") open.delete(event.messageId);
		else if (event.type === "ACTIVITY_SNAPSHOT") {
			const previous = views.get(`activity:${event.messageId}`);
			views.set(`activity:${event.messageId}`, {
				...event,
				metadata: {
					...event.metadata,
					suiming: { ...event.metadata?.suiming, sequence: previous?.metadata?.suiming?.sequence ?? sequence },
				},
			});
		} else if (event.type === "CUSTOM") views.set(`custom:${event.name}`, event);
		else if (event.type === "SUBAGENT_STARTED") subagents.set(event.subagentRunId, event);
		else if (event.type === "SUBAGENT_FINISHED" || event.type === "SUBAGENT_ERROR")
			subagents.delete(event.subagentRunId);
		else if (event.type === "RUN_STARTED") {
			lifecycle.length = 0;
			lifecycle.push(event);
			subagents.clear();
		} else if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") lifecycle.push(event);
	}
	if (lifecycle[0] === undefined) return [];
	// 还在流的消息不进消息快照：按开始加已有内容重放，之后的增量与结束才接得上（官方客户端只认开过头的消息）。
	const streaming = [...open].flatMap((id): SessionEventBody[] => {
		const message = messages.get(id) as Message & { role: "assistant" | "user"; content: string };
		const origin = message.subagentRunId === undefined ? {} : { subagentRunId: message.subagentRunId };
		return [
			{
				type: EventType.TEXT_MESSAGE_START,
				messageId: id,
				role: message.role,
				metadata: message.metadata,
				...origin,
			} as SessionEventBody,
			...(message.content
				? [
						{
							type: EventType.TEXT_MESSAGE_CONTENT,
							messageId: id,
							delta: message.content,
							...origin,
						} as SessionEventBody,
					]
				: []),
		];
	});
	return [
		lifecycle[0],
		...subagents.values(),
		{
			type: EventType.MESSAGES_SNAPSHOT,
			messages: [...messages.values()].filter((message) => !open.has(message.id)),
		},
		...views.values(),
		...streaming,
		...lifecycle.slice(1),
	];
}
