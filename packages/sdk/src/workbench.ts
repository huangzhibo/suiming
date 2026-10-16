/** 桌面临时视图能力，不是作品或执行真源。 */
export interface WorkbenchActiveContext {
	page: string;
	title: string;
	path?: string;
	view: string;
	unsaved: boolean;
	selection?: string;
	selectionTruncated?: boolean;
	comparison?: { against: "disk" | "canon"; revision: string | null };
}
export interface WorkbenchContext {
	/** 当前窗格、标签与表示；导航前用于发现作者已切页，不是持久版本。 */
	location: string;
	active: WorkbenchActiveContext;
	openDocuments: { path: string; unsaved: boolean }[];
	openDocumentCount: number;
}
export type WorkbenchRequest =
	| { action: "context" }
	| { action: "open"; path: string; expectedLocation: string; line?: number; quote?: string }
	| { action: "diff"; path: string; expectedLocation: string; against: "disk" | "canon" };
export type WorkbenchHandler = (request: WorkbenchRequest, signal?: AbortSignal) => Promise<WorkbenchContext>;
export interface RendererCall<T> {
	id: string;
	projectId: string;
	request: T;
}
export type RendererReply<T> = { id: string; ok: true; value: T } | { id: string; ok: false; error: string };
export type WorkbenchCall = RendererCall<WorkbenchRequest>;
export type WorkbenchReply = RendererReply<WorkbenchContext>;
