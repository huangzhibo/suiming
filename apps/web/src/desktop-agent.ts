import { AbstractAgent, type BaseEvent, type Message } from "@ag-ui/client";
import { Observable, throwError } from "rxjs";

/**
 * 桌面上的一个对话，由 AG-UI 官方客户端（`@ag-ui/client`）把事件拼成消息。事件经 IPC 的只读 attach 来，
 * 发送、继续、停止走命令（不变量 10），所以 `run()` 不实现，只实现长连接的 `connect()`。官方客户端按运行生命周期
 * 校验整条流，Runtime 发出的事件因此都落在某次运行之内（`run-event-stream.test.ts` 守着）。
 * 2026-10-05 之前用 TanStack AI 的 `useChat`：它内嵌另一份 @ag-ui/core（0.1.1-canary），send 抛错、isLoading 恒为 false，
 * 只用到拼消息这一项。
 */
export class DesktopAgent extends AbstractAgent {
	readonly #events: (signal: AbortSignal) => AsyncIterable<BaseEvent>;

	constructor(threadId: string, events: (signal: AbortSignal) => AsyncIterable<BaseEvent>) {
		super({ threadId });
		this.#events = events;
	}

	run(): Observable<BaseEvent> {
		return throwError(() => new Error("请通过发送消息命令开始或继续对话"));
	}

	protected override connect(): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			const controller = new AbortController();
			void (async () => {
				try {
					for await (const event of this.#events(controller.signal)) subscriber.next(event);
					subscriber.complete();
				} catch (error) {
					subscriber.error(error);
				}
			})();
			return () => controller.abort();
		});
	}
}

export interface ConversationMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	/** 持久序号：attach 快照里的消息带着它；增量里的消息由调用方从 TEXT_MESSAGE_START 记下。 */
	sequence?: number;
}

/**
 * 对话里给作者看的消息：作者与根 Agent 的话；动作快照、子任务的话（带 AG-UI 的 subagentRunId）与空消息不算。
 * 2026-10-05 之前落盘的事件没有 subagentRunId，子任务的话靠 metadata.suiming.taskKind 认（根 Agent 是 "agent"）。
 */
export function conversationMessages(messages: readonly Message[]): ConversationMessage[] {
	return messages.flatMap((message) => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		if (message.subagentRunId !== undefined) return [];
		const suiming = (message.metadata as { suiming?: { taskKind?: string; sequence?: number } } | undefined)?.suiming;
		if (suiming?.taskKind && suiming.taskKind !== "agent") return [];
		const text = typeof message.content === "string" ? message.content : "";
		if (!text) return [];
		return [
			{
				id: message.id,
				role: message.role,
				text,
				...(suiming?.sequence === undefined ? {} : { sequence: Number(suiming.sequence) }),
			},
		];
	});
}
