import { randomUUID } from "node:crypto";
import type { RendererCall, RendererReply } from "@suiming/sdk";
import { type BrowserWindow, ipcMain } from "electron";

/** 主进程向活动 renderer 请求临时能力；文件同步与界面操作共用传输和生命周期。 */
export function rendererRequests<Request, Result>(
	channel: string,
	getWindow: () => BrowserWindow | undefined,
	trusted: (url: string) => boolean,
	replay: (request: Request) => boolean,
) {
	let ready = false;
	const pending = new Map<
		string,
		{ call: RendererCall<Request>; deliver(): void; finish(reply: RendererReply<Result>): void }
	>();
	ipcMain.on(`${channel}:ready`, (event, value: boolean) => {
		if (!event.senderFrame || !trusted(event.senderFrame.url)) return;
		ready = value;
		if (ready) for (const entry of pending.values()) entry.deliver();
	});
	ipcMain.on(`${channel}:reply`, (event, reply: RendererReply<Result>) => {
		if (!event.senderFrame || !trusted(event.senderFrame.url)) return;
		pending.get(reply.id)?.finish(reply);
	});
	return {
		disconnected() {
			ready = false;
			for (const entry of pending.values())
				if (!replay(entry.call.request))
					entry.finish({
						id: entry.call.id,
						ok: false,
						error: "界面已重载或关闭，操作结果未确认；请重新查询当前状态",
					});
		},
		forProject(projectId: string) {
			return (request: Request, signal?: AbortSignal): Promise<Result> => {
				signal?.throwIfAborted();
				const window = getWindow();
				if (!window || window.isDestroyed())
					return Promise.reject(new Error("当前没有打开的桌面界面，可继续通过文件工具处理作品"));
				const call = { id: randomUUID(), projectId, request };
				return new Promise((resolve, reject) => {
					const finish = (reply: RendererReply<Result>) => {
						if (!pending.delete(call.id)) return;
						clearTimeout(timer);
						signal?.removeEventListener("abort", abort);
						if (reply.ok) resolve(reply.value);
						else reject(new Error(reply.error));
					};
					const abort = () => {
						if (!window.isDestroyed()) window.webContents.send(`${channel}:cancel`, call.id);
						finish({ id: call.id, ok: false, error: "本次操作已停止" });
					};
					const timer = setTimeout(() => {
						if (!window.isDestroyed()) window.webContents.send(`${channel}:cancel`, call.id);
						finish({ id: call.id, ok: false, error: "暂时无法联系界面，请稍后重试" });
					}, 15000);
					const deliver = () => {
						if (!window.isDestroyed()) window.webContents.send(channel, call);
					};
					pending.set(call.id, { call, deliver, finish });
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) abort();
					else if (ready) deliver();
				});
			};
		},
	};
}
