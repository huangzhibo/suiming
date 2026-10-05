import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { bridge, invoke } from "./bridge.js";
import { Book, type WorkspaceData } from "./model.js";

/**
 * 工作台读的作品数据：作品投影、对话列表、文件树、审稿与最近作品，拼成 `Book`。
 * 每个窗格各调一次；query key 相同，React Query 只发一次请求。
 */
export function useWorkspaceData() {
	const queryClient = useQueryClient();
	const projection = useQuery({ queryKey: ["workspace"], queryFn: () => invoke("workspace.show", {}), retry: false });
	const execution = useQuery({ queryKey: ["session-list"], queryFn: () => invoke("session.list", {}) });
	const directory = useQuery({ queryKey: ["project-files"], queryFn: () => invoke("workspace.files", {}) });
	const sessionsOf = useCallback(
		(projectId: string) =>
			execution.data?.projectId === projectId
				? execution.data.sessions.filter((session) => session.kind === "agent")
				: [],
		[execution.data],
	);
	const shown = useMemo<WorkspaceData | undefined>(
		() =>
			(projection.data ? { ...projection.data, sessions: sessionsOf(projection.data.projectId) } : undefined) ??
			(projection.isError && directory.data
				? {
						projectId: directory.data.projectId,
						checkoutPath: directory.data.checkoutPath,
						revisionId: directory.data.revisionId,
						revisions: directory.data.revisions,
						files: [],
						volumes: [],
						dirty: false,
						sessions: sessionsOf(directory.data.projectId),
						storyText: [],
						storyIndexError: projection.error?.message ?? "作品正在读取，可先浏览文件。",
					}
				: undefined),
		[projection.data, projection.error, projection.isError, directory.data, sessionsOf],
	);
	const reviewsQuery = useQuery({
		queryKey: ["reviews"],
		queryFn: () => invoke("workspace.reviews", {}),
		enabled: !!shown,
	});
	const reviews = useMemo(() => reviewsQuery.data ?? [], [reviewsQuery.data]);
	const recent = useQuery({
		queryKey: ["recent-projects", shown?.checkoutPath],
		queryFn: () => bridge().recentProjects(),
		enabled: !!shown && !!window.suiming,
	});
	// Query 的结构共享让 files / volumes / revisions 在内容不变时保持引用；session 用量刷新不重建投影。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只依赖投影用到的字段，刻意排除 runs
	const book = useMemo(
		() => (shown ? new Book(shown) : undefined),
		[
			shown?.files,
			shown?.volumes,
			shown?.revisions,
			shown?.revisionId,
			shown?.dirty,
			shown?.projectId,
			shown?.storyIndexError,
		],
	);
	const refresh = useCallback(() => {
		// context 与被审版本的文件只读已提交版本，query key 里已含 revisionId，不随事件流刷新。
		for (const key of ["workspace", "session-list", "project-files", "file", "reviews", "diff", "tasks", "inbox"])
			void queryClient.invalidateQueries({ queryKey: [key] });
	}, [queryClient]);
	return {
		queryClient,
		projection,
		directory,
		shown,
		reviews,
		reviewsLoading: reviewsQuery.isLoading,
		recent,
		book,
		refresh,
	};
}
