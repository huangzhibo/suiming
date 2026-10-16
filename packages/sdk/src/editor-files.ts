import type { RendererCall, RendererReply } from "./workbench.js";

/** 活动编辑器与文件工具之间的临时协作；不保存第二份草稿，不参与 Canon 提交。 */
export type EditorFileRequest =
	| { operation: "save"; path: string }
	| { operation: "inspect"; path: string }
	| { operation: "resolve"; path: string; content: string; draftSHA: string; fileSHA: string | null };
export interface EditorFileSnapshot {
	draft: { content: string; sha256: string; baseContent: string; baseSHA: string | null } | null;
	file: { content: string; sha256: string | null } | null;
}
export type EditorFileHandler = (
	request: EditorFileRequest,
	signal?: AbortSignal,
) => Promise<EditorFileSnapshot | null>;
export type EditorFileCall = RendererCall<EditorFileRequest>;
export type EditorFileReply = RendererReply<EditorFileSnapshot | null>;
