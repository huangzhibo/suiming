import { candidateFromStoryFiles, changeOperationsBetween } from "../artifact/change-operations.js";
import { reviewCurrency, reviewsIn, textCurrencies } from "../artifact/derived.js";
import type { ArtifactCandidate } from "../artifact/types.js";
import type { HarnessProjectPort } from "./project-port.js";

function counts(candidate: ArtifactCandidate) {
	const target = candidate.artifacts.filter((artifact) => artifact.identity.namespace.kind === "target");
	const beats = target.filter((artifact) => artifact.identity.kind === "story-beat");
	const written = new Set(
		target.filter((artifact) => artifact.identity.kind === "story-text").map((artifact) => artifact.identity.localId),
	);
	const writtenBeats = beats.filter((artifact) => written.has(artifact.identity.localId)).length;
	return { storyBeats: beats.length, storyTexts: written.size, unwrittenBeats: beats.length - writtenBeats };
}

/**
 * 作品状态的唯一投影：Agent 的 `status` 工具、CLI 的 `project.status` 与桌面共用这一份。
 * 从作品与版本真源派生；会话、文件名搜索和 trace 都不能证明是否提交。
 *
 * `state` 由 `changeOperationsBetween` 派生，与 ChangeSet 的构造用同一个判断，不另立一套
 * clean / dirty 规则。
 */
/** 作者看到的版本号（r1 起）：按历史里的位置算。状态读取与提交结果共用这一个算法，两处不会说出不同的号。 */
export function revisionLabel(revisions: readonly { id: string }[], revisionId: string): string {
	return `r${revisions.findIndex((revision) => revision.id === revisionId) + 1}`;
}

/** 每类最多列这么多 id；count 是全数。整部作品的 Design 改一处，可能让几十篇正文同时过时。 */
const MAX_STALE_IDS = 30;

function listed(ids: string[]) {
	return { count: ids.length, ids: ids.slice(0, MAX_STALE_IDS) };
}

/**
 * 过时的正文与审稿，与桌面同一套派生（`artifact/derived.ts`）：正文是写成之后它的 Design 闭包在已提交版本里改过，
 * 审稿是审的时候的主体摘要与当前候选对不上。Skill 曾说 `suim status` 会标出「Design 已变」的正文，实际只有计数，
 * Agent 的 project_status 也一样。作品读不出来（Design 解析失败、审稿文件损坏）时报原因，不让整份状态失败。
 */
async function staleArtifacts(
	project: HarnessProjectPort,
	head: string,
	committed: ArtifactCandidate,
	candidate: ArtifactCandidate,
) {
	try {
		const reader = project.historyReader();
		const texts = (await textCurrencies(reader, head, committed))
			.filter((item) => item.state === "design-changed")
			.map((item) => item.storyBeatId);
		const reviews: string[] = [];
		for (const review of reviewsIn(candidate))
			if ((await reviewCurrency(reader, head, candidate, review)).state === "stale") reviews.push(review.id);
		return { texts: listed(texts), reviews: listed(reviews) };
	} catch (error) {
		return { texts: listed([]), reviews: listed([]), error: (error as Error).message };
	}
}

/**
 * `stale: false` 给只要未提交数的内部调用（作者消息后的附注、turn 结束的对账）：它们每条消息、每个 turn 都跑，
 * 时效要走版本历史，eval-022 上整条 `suim status` 约 1 秒。
 */
export async function readProjectStatus(
	project: HarnessProjectPort,
	candidate: ArtifactCandidate,
	options: { stale?: boolean } = {},
) {
	const headRevisionId = await project.refreshHead();
	const revisions = await project.history();
	const committed = candidateFromStoryFiles(headRevisionId, await project.exportRevision(headRevisionId));
	const uncommittedChanges = changeOperationsBetween(committed, candidate).length;
	return {
		projectId: project.projectId,
		headRevisionId,
		headRevisionLabel: revisionLabel(revisions, headRevisionId),
		committedRevisionCount: revisions.length,
		state: uncommittedChanges === 0 ? ("clean" as const) : ("dirty" as const),
		committed: counts(committed),
		candidate: {
			baseRevisionId: candidate.baseRevisionId,
			...counts(candidate),
			uncommittedChanges,
		},
		...(options.stale === false
			? {}
			: { stale: await staleArtifacts(project, headRevisionId, committed, candidate) }),
	};
}
