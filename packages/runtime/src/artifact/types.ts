export type ArtifactNamespace = { kind: "target" } | { kind: "source"; sourceId: string };

export interface ArtifactIdentity {
	namespace: ArtifactNamespace;
	kind: string;
	localId: string;
}

export interface ArtifactContent {
	mediaType: string;
	bytes: Uint8Array;
}

export interface ArtifactVersion extends ArtifactContent {
	id: string;
}

/**
 * 一个版本里的某个 artifact，按内容版本列出。**只有 Cloud 需要它**：Cloud 的 store 有
 * `revision_artifacts` 表，`readVersion` 靠它判断某个 version 属不属于这个 Project。
 * 本地 Canon 是 git，版本内容就是 tree，不需要另一份清单。
 */
export interface RevisionArtifact {
	identity: ArtifactIdentity;
	artifactVersionId: string;
}

/**
 * 一个版本在 Canon 里的位置，仅此而已。
 *
 * 这里曾经带着 `artifacts: RevisionArtifact[]`，代价是 git store 为了填它必须把每个 revision 的
 * 整棵 tree 连字节读出来再逐个 sha256：eval-022 的 121 文件 / 21 revision 实测 `history()` 一次
 * 234 ms，而 `workspace.show` 每 100ms 调一次、每个 turn 开场再调一次，两个热调用方都只用
 * `{id, parentId}`。逐 artifact 清单归 Cloud 自己（`RevisionArtifact`），不进共享的版本身份。
 */
export interface ProjectRevision {
	id: string;
	parentId: string | null;
}

/**
 * 候选里的一个 artifact。
 *
 * `identity` 与 `path` 是同一个东西的两种写法，**都是事实，不是投影**：identity 是 Story Language
 * 里的引用方式（frontmatter 写 `character: [李牧]`，不写路径），path 是它在 Open Story Directory
 * 里的位置。扫描时两者一起得到，此后一路带着。
 *
 * 曾经只有 identity，路径由 `pathForIdentity` 从 `outline/story/index.yaml` 重新推导。代价是
 * Checker 拿到的卷号来自它自己推出来的路径，于是 story-outline 里那条「文件所在的卷必须与 index
 * 一致」的规则永远自证通过；真正在拦的是扫描阶段的 `noncanonical_story_path`，而它是抛异常不是
 * Checker 诊断——一个还没写进 index 的新 Beat 文件会让 `status` / `diff` / turn 开场一起炸。
 *
 * 内容就是身份的一部分：要比较内容用 `bytes` 的摘要，不要另存版本 id（那是 Cloud 对象存储的
 * 取值键，见 `RevisionArtifact`）。
 */
export interface CandidateArtifact extends ArtifactContent {
	identity: ArtifactIdentity;
	path: string;
}

export interface ArtifactCandidate {
	baseRevisionId: string;
	artifacts: CandidateArtifact[];
	/** checkout 里落在 Story 根下、Story Language 不认识的路径；Checker 据此拒绝（见 `OpenStoryDirectoryIgnoredKind`）。 */
	unrecognizedPaths?: string[];
}

/**
 * 没有 rename：identity 变化表现为 delete 加 create，引用一致性由 Checker 兜底（ADR-0009 决定 4）。
 *
 * create / replace 带 `path`，因为路径是事实而不是投影：Beat 换卷时内容一个字没改、只有路径变了，
 * 没有这个字段就不会产生任何操作，写回时文件会留在旧卷目录里。
 */
export type ChangeOperation =
	| ({ operation: "create"; identity: ArtifactIdentity; path: string } & ArtifactContent)
	| ({ operation: "replace"; identity: ArtifactIdentity; path: string } & ArtifactContent)
	| { operation: "delete"; identity: ArtifactIdentity };

export interface ChangeSet {
	baseRevisionId: string;
	operations: ChangeOperation[];
}

export type ArtifactCandidateValidator = (candidate: ArtifactCandidate) => void;
