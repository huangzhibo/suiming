import type {
	AGUIEvent,
	DesktopBridge,
	DesktopCommandFailure,
	LocalCommandInput,
	LocalCommandName,
	LocalCommandOutput,
	SessionEvent,
} from "@suiming/sdk";
import { CommandError } from "./command-error.js";

declare global {
	interface Window {
		suiming?: DesktopBridge;
	}
}
export function bridge(): DesktopBridge {
	if (!window.suiming) throw new Error("请从燧明桌面应用打开工作台");
	return window.suiming;
}
export async function invoke<K extends LocalCommandName>(
	command: K,
	input: LocalCommandInput<K>,
): Promise<LocalCommandOutput<K>> {
	try {
		return await bridge().invoke(command, input);
	} catch (error) {
		// bridge 拒绝的是普通对象（见 DesktopCommandFailure）；其它情况（如不在桌面里打开）原样抛出。
		if (error instanceof Error || typeof error !== "object" || error === null) throw error;
		throw new CommandError(error as DesktopCommandFailure);
	}
}
/**
 * 只读 attach 的事件流：先是 Runtime 给的快照（包在最近一次运行里），再按持久序号补增量，断线就隔一会儿重试。
 * 发送 / 继续 / 停止由显式命令负责，断线或重载不会另开一个 turn。`once` 读完当前的就结束（回看历史用）。
 */
export async function* attachEvents(
	sessionId: string,
	onEvent: (event: SessionEvent) => void,
	onConnection: ((state: string) => void) | undefined,
	once: boolean,
	signal: AbortSignal,
): AsyncGenerator<AGUIEvent> {
	let cursor: number | undefined;
	while (!signal.aborted) {
		let batch: LocalCommandOutput<"session.attach">;
		try {
			batch = await invoke("session.attach", {
				sessionId,
				...(cursor === undefined ? {} : { afterSequence: cursor }),
			});
		} catch {
			if (signal.aborted) return;
			onConnection?.("disconnected");
			await pause(signal, 1500);
			continue;
		}
		if (signal.aborted) return;
		onConnection?.("ready");
		for (const event of batch.snapshot ?? []) {
			onEvent({
				sessionId,
				id: `snapshot:${batch.cursor}`,
				sequence: batch.cursor,
				at: new Date().toISOString(),
				event,
			});
			yield event;
		}
		for (const record of batch.events) {
			if (record.sequence <= (cursor ?? 0)) continue;
			cursor = record.sequence;
			onEvent(record);
			// 连接只去掉持久传输信封：两端是同一份 @ag-ui/core。
			yield record.event;
		}
		cursor = batch.cursor;
		if (once) return;
		await pause(signal, 750, (listener) => bridge().onChange(listener));
	}
}

/** 等到超时、作品有变化或被取消。 */
function pause(signal: AbortSignal, ms: number, onChange?: (listener: () => void) => () => void): Promise<void> {
	return new Promise<void>((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe?.();
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		const unsubscribe = onChange?.(done);
		signal.addEventListener("abort", done, { once: true });
		if (signal.aborted) done();
	});
}
