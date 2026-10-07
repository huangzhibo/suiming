import type { ReviewFile } from "@suiming/story";
import {
	type CommittedReview,
	type ReviewCurrency,
	type RevisionHistoryReader,
	reviewCurrency,
	reviewsIn,
} from "../artifact/derived.js";
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
 * 候选里的审稿逐份算时效，基线是候选自己的 `baseRevisionId`。CLI 的 review list / show 在 checkout 上算
 * （刚 record、还没提交的也在），桌面按 head 算。2026-10-02 之前这段循环在桌面 IPC、
 * CLI review list 与 review show 各写一遍。调用方在结果上再投影各自要的东西（桌面要挂回页面的 paths 与 finding 细节）。
 */
export async function reviewSummaries(
	reader: RevisionHistoryReader,
	candidate: ArtifactCandidate,
): Promise<{ review: CommittedReview; summary: ReviewSummary }[]> {
	const reviews: { review: CommittedReview; summary: ReviewSummary }[] = [];
	for (const review of reviewsIn(candidate))
		reviews.push({
			review,
			summary: reviewSummary(review, await reviewCurrency(reader, candidate.baseRevisionId, candidate, review)),
		});
	return reviews;
}

/** head 里的审稿与它们的时效；桌面的 workspace.reviews 用。 */
export async function committedReviews(project: LocalProjectService): Promise<{
	candidate: ArtifactCandidate;
	reviews: { review: CommittedReview; summary: ReviewSummary }[];
}> {
	const reader = project.historyReader();
	const candidate = await reader.snapshot(project.project().headRevisionId);
	return { candidate, reviews: await reviewSummaries(reader, candidate) };
}
