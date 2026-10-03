import type { ReviewFile } from "@suiming/story";
import { type CommittedReview, type ReviewCurrency, reviewCurrency, reviewsIn } from "../artifact/derived.js";
import type { ArtifactCandidate } from "../artifact/types.js";
import type { LocalProjectService } from "./local-project-service.js";

/** 一份审稿的摘要与它对当前稿还算不算数。CLI 的 review list / show 与桌面的 workspace.reviews 共用。 */
export interface ReviewSummary {
	id: string;
	path: string;
	layer: ReviewFile["layer"];
	scope: ReviewFile["scope"];
	revision: string;
	current: boolean;
	changed: string[];
	verdict: ReviewFile["draft"]["verdict"];
	summary: string;
	findingCount: number;
	uncoveredCount: number;
	uncertaintyCount: number;
}

export function reviewSummary(review: CommittedReview, currency: ReviewCurrency): ReviewSummary {
	return {
		id: review.id,
		path: review.path,
		layer: review.file.layer,
		scope: review.file.scope,
		revision: currency.revision ?? review.file.revision,
		current: currency.state === "current",
		changed: currency.changed,
		verdict: review.file.draft.verdict,
		summary: review.file.draft.summary,
		findingCount: review.file.draft.findings.length,
		uncoveredCount: review.file.draft.uncovered.length,
		uncertaintyCount: review.file.draft.uncertainties.length,
	};
}

/**
 * head 里的审稿逐份算时效。2026-10-02 之前这段循环在桌面 IPC、CLI review list 与 review show 各写一遍。
 * 带回 head 的候选，调用方在上面再投影各自要的东西（桌面要挂回页面的 paths 与 finding 细节）。
 */
export async function committedReviews(project: LocalProjectService): Promise<{
	revisionId: string;
	candidate: ArtifactCandidate;
	reviews: { review: CommittedReview; summary: ReviewSummary }[];
}> {
	const revisionId = project.project().headRevisionId;
	const reader = project.historyReader();
	const candidate = await reader.snapshot(revisionId);
	const reviews: { review: CommittedReview; summary: ReviewSummary }[] = [];
	for (const review of reviewsIn(candidate))
		reviews.push({
			review,
			summary: reviewSummary(review, await reviewCurrency(reader, revisionId, candidate, review)),
		});
	return { revisionId, candidate, reviews };
}
