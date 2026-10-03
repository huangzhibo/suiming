import type { ArtifactCandidate, ArtifactCandidateValidator, ChangeSet, ProjectRevision } from "./types.js";

/**
 * Canon 存储：已提交的版本化 Story Artifact 的唯一权威（不变量 3）。
 *
 * 目前只有 git 实现（`GitCanonStore`）跑这套契约测试（`test/canon-store-contract.ts`）；Cloud 走自己的 store 接口与
 * 测试，给 Cloud 换存储时先让它满足这个接口（不变量 3，[ADR-0010](../../../../docs/adr/0010-git-as-canon-storage-engine.md)）。
 * 执行数据——Session / Task、事件、inbox、execution object——不在这个面上，它们留在 SQLite。
 * 审稿与 Source 笔记是普通 artifact，随 tree 走；正文时效、审稿时效这些派生状态由
 * `artifact/derived.ts` 用 `history` + `fileDigests` 算出来，不落在存储里。
 */
type MaybePromise<T> = T | Promise<T>;

/** 一次提交命令：`commandId` 用于崩溃后按回执去重。 */
export interface ProjectCommitCommand {
	commandId: string;
}

export interface CanonStore {
	/**
	 * 读取面一律写成「可能是 Promise」。git 读 ref 与 tree 必然异步；同步与否是实现细节，不是领域约束。
	 * 调用方一律 `await`。
	 */
	project(projectId: string): MaybePromise<{ id: string; headRevisionId: string }>;
	headRevisionId(projectId: string): MaybePromise<string>;

	/** 从创世到 head 的祖先链，最老的在前。 */
	history(projectId: string): MaybePromise<ProjectRevision[]>;
	readProjectRevision(projectId: string, revisionId: string): MaybePromise<ProjectRevision>;
	/** 某个版本的全部 Story artifact，作为候选的起点。 */
	snapshotForProject(projectId: string, revisionId: string): Promise<ArtifactCandidate>;
	/** 某个版本下每个作品文件的内容摘要，路径 → 摘要；只要求同一实现内可比较（git 用 blob oid）。 */
	fileDigests(projectId: string, revisionId: string): Promise<ReadonlyMap<string, string>>;

	/**
	 * 推进 Canon。`validate` 在写入前跑，失败即不产生版本；`command` 给出时按 commandId 去重，
	 * 同一命令重放返回同一个版本，不重复推进。
	 */
	commit(
		projectId: string,
		changeSet: ChangeSet,
		validate: ArtifactCandidateValidator,
		command?: ProjectCommitCommand,
	): Promise<ProjectRevision>;

	/** 崩溃后核对某条提交命令是否已经生效：进程退出时提交可能已落盘但回执未发出。 */
	readCommitReceipt(projectId: string, commandId: string): MaybePromise<ProjectRevision | undefined>;
}
