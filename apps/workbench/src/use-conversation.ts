import type { SessionEvent } from "@suiming/sdk";
import { useEffect, useState } from "react";
import { attachEvents } from "./bridge.js";
import { type ConversationMessage, conversationMessages, DesktopAgent } from "./desktop-agent.js";

/** 一个对话的消息与「正在生成」：正在生成由 RUN_STARTED / RUN_FINISHED / RUN_ERROR 决定。 */
export function useConversation(
	sessionId: string,
	onEvent: (event: SessionEvent) => void,
	onConnection: (state: string) => void,
	once: boolean,
): { messages: ConversationMessage[]; generating: boolean } {
	const [messages, setMessages] = useState<ConversationMessage[]>([]);
	const [generating, setGenerating] = useState(false);
	useEffect(() => {
		setMessages([]);
		setGenerating(false);
		const agent = new DesktopAgent(sessionId, (signal) =>
			attachEvents(sessionId, onEvent, onConnection, once, signal),
		);
		// 官方客户端每应用一个事件就回调一次：长对话 attach 时一次重放几千个事件，逐个过滤消息再重渲染会卡住主线程，
		// 这里只记下最新的列表，按帧合成一次。
		let latest: Parameters<typeof conversationMessages>[0] = [];
		let frame = 0;
		const { unsubscribe } = agent.subscribe({
			onMessagesChanged: ({ messages: next }) => {
				latest = next;
				if (!frame)
					frame = requestAnimationFrame(() => {
						frame = 0;
						setMessages(conversationMessages(latest));
					});
			},
			onRunStartedEvent: () => {
				setGenerating(true);
			},
			onRunFinishedEvent: () => {
				setGenerating(false);
			},
			onRunErrorEvent: () => {
				setGenerating(false);
			},
		});
		// 校验失败或连接出错时整条流停下：如实报到控制台（E2E 收集页面错误），连接状态标成断开。
		agent.connectAgent().catch((error: unknown) => {
			console.error(error);
			onConnection("disconnected");
		});
		return () => {
			cancelAnimationFrame(frame);
			unsubscribe();
			void agent.detachActiveRun();
		};
	}, [sessionId, onEvent, onConnection, once]);
	return { messages, generating };
}
