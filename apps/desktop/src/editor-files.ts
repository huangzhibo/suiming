import type { EditorFileRequest, EditorFileSnapshot } from "@suiming/sdk";
import type { BrowserWindow } from "electron";
import { rendererRequests } from "./renderer-requests.js";

export function editorFilesBridge(getWindow: () => BrowserWindow, trusted: (url: string) => boolean) {
	return rendererRequests<EditorFileRequest, EditorFileSnapshot | null>(
		"suiming:editor-file",
		getWindow,
		trusted,
		(request) => request.operation !== "resolve",
	);
}
