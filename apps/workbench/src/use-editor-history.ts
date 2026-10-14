import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

/** 只保留 CodeMirror 状态，不保留 DOM；撤销历史属于当前作品里仍打开的标签，不写入持久草稿。 */
export interface EditorScroll {
	snapshot: ReturnType<EditorView["scrollSnapshot"]>;
	anchor: number;
	offset: number;
}

export interface EditorHistory {
	state: EditorState | null;
	scroll?: EditorScroll;
	before?: { doc: Text; scroll: EditorScroll };
}

export function useEditorHistory(project: string, tabs: readonly { id: string }[]) {
	const cache = useRef({ project, entries: new Map<string, { tab: string; history: EditorHistory }>() });
	if (cache.current.project !== project) cache.current = { project, entries: new Map() };
	useEffect(() => {
		const open = new Set(tabs.map((tab) => tab.id));
		for (const [key, entry] of cache.current.entries) if (!open.has(entry.tab)) cache.current.entries.delete(key);
	}, [tabs]);
	return (tab: string, path: string): EditorHistory => {
		const key = `${tab}:${path}`;
		let entry = cache.current.entries.get(key);
		if (!entry) {
			entry = { tab, history: { state: null } };
			cache.current.entries.set(key, entry);
		}
		return entry.history;
	};
}
