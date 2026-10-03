import type {
	DesktopBridge,
	DesktopCommandFailure,
	LocalCommandInput,
	LocalCommandName,
	LocalCommandOutput,
	SessionEvent,
} from "@suiming/sdk";
import type { SubscribeConnectionAdapter } from "@tanstack/ai-client";
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
/** 只读 attach。发送 / 继续 / 停止由显式命令负责，断线或重载不会另开一个 turn。 */
export function ipcConnection(
	sessionId: string,
	onEvent: (event: SessionEvent) => void,
	onConnection?: (state: string) => void,
	once = false,
): SubscribeConnectionAdapter {
	return {
		async *subscribe(signal) {
			let cursor: number | undefined;
			while (!signal?.aborted) {
				let batch: LocalCommandOutput<"session.attach">;
				try {
					batch = await invoke("session.attach", {
						sessionId,
						...(cursor === undefined ? {} : { afterSequence: cursor }),
					});
				} catch {
					if (signal?.aborted) return;
					onConnection?.("disconnected");
					await new Promise<void>((resolve) => {
						const timer = setTimeout(done, 1500);
						function done() {
							clearTimeout(timer);
							signal?.removeEventListener("abort", done);
							resolve();
						}
						signal?.addEventListener("abort", done, { once: true });
						if (signal?.aborted) done();
					});
					continue;
				}
				if (signal?.aborted) return;
				onConnection?.("ready");
				for (const event of batch.snapshot ?? []) {
					onEvent({
						sessionId,
						id: `snapshot:${batch.cursor}`,
						sequence: batch.cursor,
						at: new Date().toISOString(),
						event,
					});
					yield event as ReturnType<SubscribeConnectionAdapter["subscribe"]> extends AsyncIterable<infer Chunk>
						? Chunk
						: never;
				}
				for (const record of batch.events) {
					if (record.sequence <= (cursor ?? 0)) continue;
					cursor = record.sequence;
					onEvent(record);
					// 两端共享上游 AG-UI schema；连接只去掉持久传输信封。
					yield record.event as ReturnType<SubscribeConnectionAdapter["subscribe"]> extends AsyncIterable<
						infer Chunk
					>
						? Chunk
						: never;
				}
				cursor = batch.cursor;
				if (once) return;
				await new Promise<void>((resolve) => {
					let settled = false;
					const done = () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						unsubscribe();
						signal?.removeEventListener("abort", done);
						resolve();
					};
					const timer = setTimeout(done, 750);
					const unsubscribe = bridge().onChange(done);
					signal?.addEventListener("abort", done, { once: true });
					if (signal?.aborted) done();
				});
			}
		},
		async send() {
			throw new Error("请通过发送消息命令开始或继续对话");
		},
	};
}
