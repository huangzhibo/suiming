import { type Dispatch, type SetStateAction, useRef } from "react";
import {
	acknowledgeSubmission,
	type ComposerAttachment,
	type ComposerDraft,
	settleComposerAttachment,
	updateComposerDraft,
} from "./composer-state.js";
import type { ConversationPosition } from "./conversation-viewport.js";
import { saveWorkspace, type WorkspaceLayout } from "./workspace-layout.js";

/** 绑定在工作区根节点：关闭文档窗格不会让发送回执和附件读取失去接收方。 */
export function useComposerWorkspace(
	layout: WorkspaceLayout,
	setLayout: Dispatch<SetStateAction<WorkspaceLayout>>,
	projectId: string,
) {
	const current = useRef({ layout, projectId });
	current.current = { layout, projectId };
	const isCurrentProject = () => !!projectId && current.current.projectId === projectId;
	const change = (update: (state: WorkspaceLayout) => WorkspaceLayout) => {
		if (isCurrentProject()) setLayout((state) => (isCurrentProject() ? update(state) : state));
	};
	return {
		isCurrentProject,
		updateComposer(key: string, update: (draft: ComposerDraft) => ComposerDraft, persist = false) {
			if (!isCurrentProject()) return;
			if (persist) {
				const next = updateComposerDraft(current.current.layout, key, update);
				// 发送前持久化成功才返回；失败由输入器展示，不能先发出请求再保存 commandId。
				saveWorkspace(projectId, next);
				current.current.layout = next;
				setLayout(next);
			} else change((state) => updateComposerDraft(state, key, update));
		},
		onSubmitted(key: string, id: string, sessionId: string) {
			change((state) => acknowledgeSubmission(state, key, id, sessionId));
		},
		completeAttachment(result: ComposerAttachment) {
			change((state) => settleComposerAttachment(state, result));
		},
		savePosition(key: string, position: ConversationPosition) {
			change((state) => ({ ...state, conversationPositions: { ...state.conversationPositions, [key]: position } }));
		},
	};
}
