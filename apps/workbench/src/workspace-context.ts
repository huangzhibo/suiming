import { createContext, type Dispatch, type SetStateAction, useContext } from "react";
import type { useComposerWorkspace } from "./use-composer-workspace.js";
import type { WorkspaceLayout } from "./workspace-layout.js";

/**
 * 一次性提示。检查结果这类需要作者去看的，带一个打开详情页的动作；`warn` 用与错误同一种底色，
 * 未通过的检查不该显示成绿色。
 */
export type Notice = string | { text: string; tone: "ok" | "warn"; action?: { label: string; page: string } };

/** 整个工作台共用一份：布局（含各窗格）、当前作品、弹窗、提示与忙碌态。 */
export const WorkspaceContext = createContext<{
	composerActions: ReturnType<typeof useComposerWorkspace>;
	layout: WorkspaceLayout;
	setLayout: Dispatch<SetStateAction<WorkspaceLayout>>;
	projectId: string;
	setProjectId: Dispatch<SetStateAction<string>>;
	panePriority: "left" | "right";
	setPanePriority: Dispatch<SetStateAction<"left" | "right">>;
	settingsOpen: boolean;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	helpOpen: boolean;
	setHelpOpen: Dispatch<SetStateAction<boolean>>;
	error: string;
	setError: Dispatch<SetStateAction<string>>;
	notice: Notice;
	setNotice: Dispatch<SetStateAction<Notice>>;
	busy: boolean;
	setBusy: Dispatch<SetStateAction<boolean>>;
} | null>(null);
export function useWorkspace() {
	const context = useContext(WorkspaceContext);
	if (!context) throw new Error("工作区尚未初始化");
	return context;
}
