import type { RevisionHistoryReader } from "../artifact/derived.js";
import type { OpenPackageFile } from "../artifact/open-package.js";
import type { ProjectRevision } from "../artifact/types.js";
import type { InMemoryExecutionState } from "../execution/in-memory-execution-state.js";
import type { ExecutionEntities, ExecutionStateSnapshot } from "../execution/types.js";
import type { SessionEvent } from "./events.js";

/**
 * Harness 对 Project 的全部依赖，`SuimingHarness` 只认这个端口。
 *
 * 「deployment-neutral Runtime」过去是一句不成立的声称：`SuimingHarnessOptions.project` 的类型是
 * 具体类 `LocalProjectService`，Cloud 接不进来的直接原因就是这个。端口只列 harness 真正调用的成员；
 * 新增成员必须先有 harness 的调用点，不为「Cloud 以后可能要」预留。
 */
export interface HarnessProjectPort {
	readonly projectId: string;
	/** Agent 的文件工具直接在这个目录里工作：作者、host agent 与 Agent 共用一份候选，没有 per-session worktree。 */
	readonly paths: { readonly checkoutPath: string };

	/** head 是最后一次读到的值；别的进程可能已推进 Canon，需要准确值先 `refreshHead()`。 */
	project(): { id: string; headRevisionId: string };
	refreshHead(): Promise<string>;
	/** Canon 换成 git 后 history 是异步的；同步与否是实现细节，端口两种都收。 */
	history(): ProjectRevision[] | Promise<ProjectRevision[]>;
	exportRevision(revisionId?: string): Promise<OpenPackageFile[]>;
	/** 派生状态（正文与审稿时效）与基线快照的历史读取面。 */
	historyReader(): RevisionHistoryReader;
	/**
	 * 扫 checkout diff → ChangeSet → Checker → 推进 Canon → 同步 checkout。作者的「提交」按钮、host 的
	 * `suim commit` 与 Agent 的 `commit` 是同一个方法；`commandId` 只多一个回执，用于崩溃后按回执去重。
	 */
	commitCheckout(command?: { commandId: string }): Promise<{ created: boolean; revision: ProjectRevision }>;

	saveExecutionObject(mediaType: string, bytes: Uint8Array): Promise<{ id: string }>;
	readExecutionObject(id: string): Promise<{ id: string; mediaType: string; bytes: Uint8Array }>;

	/** 只读查询用：session 与 task，不带命令回执。 */
	loadExecutionEntities(): ExecutionEntities;
	createExecutionState(options?: { now?: () => Date }): InMemoryExecutionState;
	appendSessionEvents(events: readonly SessionEvent[], ownerFence?: ExecutionStateSnapshot["ownerFence"]): void;
	readSessionEvents(sessionId: string, afterSequence?: number): SessionEvent[];
	/** 作者的收件箱：第一条消息和后续补充走同一条通道，根 loop 在 `ready` 阶段第一步取走。入队不经过 Harness。 */
	readInbox(sessionId: string): { sequence: number; text: string }[];
	recoverCommittedAction(commandId: string): Promise<ProjectRevision | undefined>;
}
