import { randomUUID } from "node:crypto";
import type { EditorFileCall, EditorFileHandler, EditorFileReply, EditorFileSnapshot } from "@suiming/sdk";
import { type BrowserWindow, ipcMain } from "electron";

/** 临时请求通道。草稿仍只由工作台持有；重载重接准备请求，合并写入不自动重放。 */
export function editorFilesBridge(getWindow: () => BrowserWindow, trusted: (url: string) => boolean) {
	let ready = false;
	const pending = new Map<string, { call: EditorFileCall; deliver(): void; finish(reply: EditorFileReply): void }>();
	ipcMain.on("suiming:editor-ready", (event, value: boolean) => {
		if (!event.senderFrame || !trusted(event.senderFrame.url)) return;
		ready = value;
		if (ready) for (const entry of pending.values()) entry.deliver();
	});
	ipcMain.on("suiming:editor-reply", (event, reply: EditorFileReply) => {
		if (!event.senderFrame || !trusted(event.senderFrame.url)) return;
		pending.get(reply.id)?.finish(reply);
	});
	return {
		disconnected() {
			ready = false;
			for (const entry of pending.values()) {
				if (entry.call.request.operation === "resolve")
					entry.finish({
						id: entry.call.id,
						ok: false,
						error: "编辑器已重载，合并结果尚未确认；请重新读取两边内容",
					});
			}
		},
		forProject(projectId: string): EditorFileHandler {
			return (request, signal) => {
				signal?.throwIfAborted();
				const window = getWindow();
				const call: EditorFileCall = { id: randomUUID(), projectId, request };
				return new Promise<EditorFileSnapshot | null>((resolve, reject) => {
					const finish = (reply: EditorFileReply) => {
						if (!pending.delete(call.id)) return;
						clearTimeout(timer);
						signal?.removeEventListener("abort", abort);
						if (reply.ok) resolve(reply.value);
						else reject(new Error(reply.error));
					};
					const abort = () => finish({ id: call.id, ok: false, error: "本次文件操作已停止" });
					const timer = setTimeout(
						() => finish({ id: call.id, ok: false, error: "暂时无法同步编辑器，请稍后重试此文件" }),
						15000,
					);
					const deliver = () => {
						if (!window.isDestroyed()) window.webContents.send("suiming:editor-file", call);
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
