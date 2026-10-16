/// <reference lib="dom" />

import type {
	DesktopBridge,
	DesktopCommandFailure,
	LocalCommandInput,
	LocalCommandName,
	LocalCommandOutput,
	RendererCall,
	RendererReply,
	WorkspaceChange,
} from "@suiming/sdk";
import { contextBridge, ipcRenderer } from "electron";

// DOM 与隔离世界共享；仅 macOS 普通窗口为左侧原生按钮预留空间。
let fullscreen = false;
function syncWindowChrome() {
	if (!document.documentElement) return;
	document.documentElement.dataset.windowControls = process.platform === "darwin" && !fullscreen ? "left" : "none";
}
ipcRenderer.on("suiming:window-fullscreen", (_event, value: boolean) => {
	fullscreen = value;
	syncWindowChrome();
});
window.addEventListener("DOMContentLoaded", syncWindowChrome, { once: true });

function unwrap<T>(reply: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
	if (!reply.ok) throw new Error(reply.error.message);
	return reply.value;
}
function listen<Request, Result>(
	channel: string,
	listener: (call: RendererCall<Request>, cancelled: () => boolean) => Promise<RendererReply<Result>>,
) {
	const pending = new Map<string, AbortController>();
	const cancel = (_event: Electron.IpcRendererEvent, id: string) => pending.get(id)?.abort();
	const handler = async (_event: Electron.IpcRendererEvent, call: RendererCall<Request>) => {
		if (pending.has(call.id)) return;
		const controller = new AbortController();
		pending.set(call.id, controller);
		try {
			ipcRenderer.send(`${channel}:reply`, await listener(call, () => controller.signal.aborted));
		} catch (error) {
			ipcRenderer.send(`${channel}:reply`, {
				id: call.id,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			pending.delete(call.id);
		}
	};
	ipcRenderer.on(channel, handler);
	ipcRenderer.on(`${channel}:cancel`, cancel);
	ipcRenderer.send(`${channel}:ready`, true);
	return () => {
		ipcRenderer.removeListener(channel, handler);
		ipcRenderer.removeListener(`${channel}:cancel`, cancel);
		ipcRenderer.send(`${channel}:ready`, false);
		for (const controller of pending.values()) controller.abort();
	};
}
const bridge: DesktopBridge = {
	onEditorFile: (listener) => listen("suiming:editor-file", listener),
	onWorkbench: (listener) => listen("suiming:workbench", listener),
	async invoke<K extends LocalCommandName>(command: K, input: LocalCommandInput<K>): Promise<LocalCommandOutput<K>> {
		const reply: { ok: true; value: LocalCommandOutput<K> } | { ok: false; error: DesktopCommandFailure } =
			await ipcRenderer.invoke("suiming:command", { command, input });
		// 普通对象才能带着 code 与 diagnostics 过 contextBridge，见 DesktopCommandFailure。
		if (!reply.ok) throw reply.error;
		return reply.value;
	},
	chooseProject: async (create) => unwrap(await ipcRenderer.invoke("suiming:choose-project", create)),
	exportConversation: async (content) => unwrap(await ipcRenderer.invoke("suiming:export-conversation", content)),
	recentProjects: () => ipcRenderer.invoke("suiming:recent-projects"),
	openProject: async (path) => unwrap(await ipcRenderer.invoke("suiming:open-project", path)),
	onChange(listener) {
		const handler = (_event: Electron.IpcRendererEvent, changes: WorkspaceChange[]) => listener(changes);
		ipcRenderer.on("suiming:changed", handler);
		return () => ipcRenderer.removeListener("suiming:changed", handler);
	},
};
contextBridge.exposeInMainWorld("suiming", bridge);
