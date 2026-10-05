export {
	type SessionEvent,
	type SessionEventBody,
	type SessionEventListener,
	SessionEventSchema,
	type SessionEventType,
} from "@suiming/sdk";

import { randomUUID } from "node:crypto";
import {
	EventType,
	type SessionEvent,
	type SessionEventBody,
	type SessionEventListener,
	validateProductEvent,
} from "@suiming/sdk";

/** 唯一 UI 事件日志；确认后发布，稳定 id 补发去重，订阅错误与持久错误分开处理。 */
export class SessionEventStream {
	readonly sessionId: string;
	readonly #now: () => Date;
	readonly #listeners = new Set<SessionEventListener>();
	readonly #events: SessionEvent[];
	readonly #ids: Map<string, SessionEvent>;
	/** 每条消息已持久的正文，随事件追加；流式补发每 40ms 一次，不能每次扫一遍整个会话的事件。 */
	readonly #texts = new Map<string, string>();
	readonly #read: ((afterSequence: number) => SessionEvent[]) | undefined;
	readonly #persist: ((event: SessionEvent) => void) | undefined;
	readonly #pendingText = new Map<string, { text: string; flushedAt: number }>();
	#failure: { error: unknown } | undefined;
	#sequence: number;
	constructor(
		sessionId: string,
		now: () => Date = () => new Date(),
		options: {
			history?: SessionEvent[];
			read?: (afterSequence: number) => SessionEvent[];
			persist?: (event: SessionEvent) => void;
		} = {},
	) {
		this.sessionId = sessionId;
		this.#now = now;
		this.#persist = options.persist;
		this.#read = options.read;
		this.#events = structuredClone(options.history ?? []);
		this.#sequence = this.#events.at(-1)?.sequence ?? 0;
		this.#ids = new Map(this.#events.map((event) => [event.id, event]));
		for (const event of this.#events) this.#indexText(event);
	}
	#indexText({ event }: SessionEvent): void {
		if (event.type === EventType.TEXT_MESSAGE_CONTENT)
			this.#texts.set(event.messageId, (this.#texts.get(event.messageId) ?? "") + event.delta);
	}
	refresh(): void {
		for (const event of this.#read?.(this.#sequence) ?? []) {
			this.#sequence = event.sequence;
			this.#events.push(structuredClone(event));
			this.#ids.set(event.id, structuredClone(event));
			this.#indexText(event);
			for (const listener of this.#listeners) {
				try {
					listener(structuredClone(event));
				} catch {
					/* UI listener 隔离 */
				}
			}
		}
	}
	subscribe(listener: SessionEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	emit(event: SessionEventBody, id: string = randomUUID()): SessionEvent {
		this.assertWritable();
		this.refresh();
		validateProductEvent(event);
		const previous = this.#ids.get(id);
		if (previous !== undefined) {
			if (JSON.stringify(previous.event) !== JSON.stringify(event))
				throw new Error(`Event ${id} changed during replay`);
			return structuredClone(previous);
		}
		const envelope: SessionEvent = {
			sessionId: this.sessionId,
			sequence: this.#sequence + 1,
			at: this.#now().toISOString(),
			id,
			event,
		};
		try {
			this.#persist?.(structuredClone(envelope));
		} catch (error) {
			this.#failure = { error };
			throw error;
		}
		this.#sequence = envelope.sequence;
		this.#events.push(structuredClone(envelope));
		this.#ids.set(id, structuredClone(envelope));
		this.#indexText(envelope);
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(envelope));
			} catch {
				/* UI listener 隔离。 */
			}
		}
		return structuredClone(envelope);
	}
	appendText(messageId: string, delta: string, metadata: Record<string, unknown>, subagentRunId?: string): void {
		const pending = this.#pendingText.get(messageId) ?? { text: "", flushedAt: Date.now() };
		pending.text += delta;
		this.#pendingText.set(messageId, pending);
		if (pending.text.length >= 512 || Date.now() - pending.flushedAt >= 40)
			this.#flushText(messageId, metadata, subagentRunId);
	}
	#flushText(messageId: string, metadata: Record<string, unknown>, subagentRunId?: string): void {
		const pending = this.#pendingText.get(messageId);
		if (!pending?.text) return;
		const previous = this.messageText(messageId);
		this.message(messageId, previous + pending.text, false, metadata, "assistant", subagentRunId);
		pending.text = "";
		pending.flushedAt = Date.now();
	}
	messageText(messageId: string): string {
		return this.#texts.get(messageId) ?? "";
	}
	/**
	 * 已确认完整模型响应可以补齐尚未发布的文本；不依赖易丢失的 streaming callback。子任务的话带 `subagentRunId`
	 * （就是 task id，AG-UI 的 subagent 标准写法），根 Agent 与作者的话不带。
	 */
	message(
		messageId: string,
		text: string,
		complete: boolean,
		metadata: Record<string, unknown>,
		role: "assistant" | "user" = "assistant",
		subagentRunId?: string,
	): void {
		const previous = this.messageText(messageId);
		if (!text.startsWith(previous)) throw new Error(`Message ${messageId} does not match persisted prefix`);
		if (text.length === 0) return;
		const origin = subagentRunId === undefined ? {} : { subagentRunId };
		this.emit({ type: EventType.TEXT_MESSAGE_START, messageId, role, metadata, ...origin }, `${messageId}:start`);
		const delta = text.slice(previous.length);
		if (delta.length > 0)
			this.emit(
				{ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta, metadata, ...origin },
				`${messageId}:text:${previous.length}`,
			);
		if (complete) {
			this.#pendingText.delete(messageId);
			this.emit({ type: EventType.TEXT_MESSAGE_END, messageId, metadata, ...origin }, `${messageId}:end`);
		}
	}
	assertWritable(): void {
		if (this.#failure !== undefined) throw this.#failure.error;
	}
	/** 最后一条已持久事件的序号；turn 开始时记下，结束时的对账只看这之后的事件。 */
	lastSequence(): number {
		this.refresh();
		return this.#sequence;
	}
	/** 序号大于 sequence 的已持久事件，不必为一个 turn 克隆整个会话的事件。 */
	durableEventsAfter(sequence: number): SessionEvent[] {
		this.refresh();
		const index = this.#events.findIndex((event) => event.sequence > sequence);
		return index < 0 ? [] : structuredClone(this.#events.slice(index));
	}
	/** 按 id 取一条已持久的事件；不必为找一条而克隆整个会话的事件。 */
	durableEvent(id: string): SessionEvent | undefined {
		this.refresh();
		const event = this.#ids.get(id);
		return event === undefined ? undefined : structuredClone(event);
	}
}
