import type { AGUIMessage as Message } from "@suiming/sdk";
import { EventType, type SessionEvent, type SessionEventBody } from "@suiming/sdk";
/**
 * 查询持久事件的一次读取结果，不存第二份聊天状态，不产生执行命令。快照包在最近一次运行里（它的 RUN_STARTED 打头，
 * 结束了就以它的 RUN_FINISHED 收尾），符合 AG-UI 的运行生命周期；还没跑过的对话没有消息，返回空。
 */
export function productEventSnapshot(events: readonly SessionEvent[]): SessionEventBody[] {
	const messages = new Map<string, Message>();
	const views = new Map<string, SessionEventBody>();
	const lifecycle: SessionEventBody[] = [];
	for (const { event, sequence } of events) {
		if (event.type === "TEXT_MESSAGE_START")
			messages.set(event.messageId, {
				id: event.messageId,
				role: event.role,
				content: "",
				metadata: { ...event.metadata, suiming: { ...event.metadata?.suiming, sequence } },
			} as Message);
		else if (event.type === "TEXT_MESSAGE_CONTENT") {
			const message = messages.get(event.messageId);
			if (message && typeof message.content === "string") message.content += event.delta;
		} else if (event.type === "ACTIVITY_SNAPSHOT") {
			const previous = views.get(`activity:${event.messageId}`);
			views.set(`activity:${event.messageId}`, {
				...event,
				metadata: {
					...event.metadata,
					suiming: { ...event.metadata?.suiming, sequence: previous?.metadata?.suiming?.sequence ?? sequence },
				},
			});
		} else if (event.type === "CUSTOM") views.set(`custom:${event.name}`, event);
		else if (event.type === "RUN_STARTED") {
			lifecycle.length = 0;
			lifecycle.push(event);
		} else if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") lifecycle.push(event);
	}
	if (lifecycle[0] === undefined) return [];
	return [
		lifecycle[0],
		{ type: EventType.MESSAGES_SNAPSHOT, messages: [...messages.values()] },
		...views.values(),
		...lifecycle.slice(1),
	];
}
