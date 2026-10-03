import {
	deriveRelease,
	parseReleaseManifest,
	parseYaml,
	type ReleaseManifest,
	type ReleaseStoryTextInput,
	type ReviewVerdict,
	renderReleaseManifest,
	verifyRelease,
} from "@suiming/story";
import { type RevisionHistoryReader, releaseReadiness, reviewCurrency, reviewsIn } from "./derived.js";
import { ArtifactError } from "./errors.js";
import { isTargetArtifactIdentity, targetArtifactIdentity } from "./identity.js";
import { inspectStoryDesignCandidate } from "./story-design-validator.js";
import type { ArtifactCandidate, CandidateArtifact, ChangeOperation } from "./types.js";

export interface PublishReleaseInput {
	/** 当前 head 的快照；Release 只能从它派生。 */
	candidate: ArtifactCandidate;
	headRevisionId: string;
	/** 绑定的全书正文审稿：`review/<id>.md` 的 id；给了就必须 current。 */
	storyTextReview?: string;
	targetCodePoints?: number;
	minCodePoints?: number;
	maxCodePoints?: number;
}

export interface PublishReleaseResult {
	/** 把 Release 写进作品的 ChangeSet 操作；由调用方提交。 */
	operations: ChangeOperation[];
	manifest: ReleaseManifest;
	reviewVerdict?: ReviewVerdict;
}

export interface ReleaseStatus {
	state: "missing" | "current" | "stale" | "invalid";
	chapterCount: number;
	reviewVerdict?: ReviewVerdict;
	reason?: string;
}

function utf8(artifact: CandidateArtifact, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
	} catch {
		throw new ArtifactError("invalid_utf8", `${label} must contain UTF-8 text`);
	}
}

function orderedStoryText(candidate: ArtifactCandidate): ReleaseStoryTextInput[] {
	const design = inspectStoryDesignCandidate(candidate).design;
	const byStoryBeatId = new Map(
		candidate.artifacts
			.filter((artifact) => isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "story-text")
			.map((artifact) => [artifact.identity.localId, artifact]),
	);
	return design.story.beats.map((beat) => {
		const artifact = byStoryBeatId.get(beat.id);
		if (artifact === undefined) throw new ArtifactError("story_text_not_found", `还没有正文：${beat.id}`);
		return { storyBeatId: beat.id, text: utf8(artifact, `StoryText ${beat.id}`) };
	});
}

function releaseArtifacts(candidate: ArtifactCandidate): CandidateArtifact[] {
	return candidate.artifacts.filter(
		(artifact) =>
			isTargetArtifactIdentity(artifact.identity) &&
			["release-manifest", "release-chapter"].includes(artifact.identity.kind),
	);
}

/** 发布：正文完整且全部 current；指定审稿时它必须是 current 的全书正文审稿。verdict 原样带出，不要求 pass。 */
export async function publishRelease(
	reader: RevisionHistoryReader,
	input: PublishReleaseInput,
): Promise<PublishReleaseResult> {
	const readiness = await releaseReadiness(reader, input.headRevisionId, input.candidate);
	const textBlockers = readiness.blockers.filter((blocker) => !blocker.startsWith("没有 current 的全书正文审稿"));
	if (textBlockers.length > 0) throw new ArtifactError("story_text_not_current", textBlockers.join("; "));
	let reviewVerdict: ReviewVerdict | undefined;
	if (input.storyTextReview !== undefined) {
		const review = reviewsIn(input.candidate).find((item) => item.id === input.storyTextReview);
		if (review === undefined || review.file.layer !== "text" || review.file.scope.kind !== "book")
			throw new ArtifactError("invalid_release_review", `${input.storyTextReview} 不是全书正文审稿`);
		const currency = await reviewCurrency(reader, input.headRevisionId, input.candidate, review);
		if (currency.state !== "current")
			throw new ArtifactError(
				"review_not_current",
				`${input.storyTextReview} 已过时${currency.changed.length ? `：${currency.changed.join("、")}` : ""}`,
			);
		reviewVerdict = review.file.draft.verdict;
	}
	const release = deriveRelease({
		revision: input.headRevisionId,
		...(input.storyTextReview === undefined ? {} : { storyTextReview: input.storyTextReview }),
		storyText: orderedStoryText(input.candidate),
		...(input.targetCodePoints === undefined ? {} : { targetCodePoints: input.targetCodePoints }),
		...(input.minCodePoints === undefined ? {} : { minCodePoints: input.minCodePoints }),
		...(input.maxCodePoints === undefined ? {} : { maxCodePoints: input.maxCodePoints }),
	});
	const operations: ChangeOperation[] = [
		...releaseArtifacts(input.candidate).map(
			(artifact): ChangeOperation => ({ operation: "delete", identity: artifact.identity }),
		),
		{
			operation: "create",
			identity: targetArtifactIdentity("release-manifest", "main"),
			path: "release/manifest.yaml",
			mediaType: "application/yaml; charset=utf-8",
			bytes: new TextEncoder().encode(renderReleaseManifest(release.manifest)),
		},
		...release.chapters.map(
			(chapter): ChangeOperation => ({
				operation: "create",
				identity: targetArtifactIdentity("release-chapter", chapter.id),
				path: `release/chapters/${chapter.id}.md`,
				mediaType: "text/markdown; charset=utf-8",
				bytes: new TextEncoder().encode(chapter.text),
			}),
		),
	];
	return { operations, manifest: release.manifest, ...(reviewVerdict === undefined ? {} : { reviewVerdict }) };
}

/**
 * Release 状态按值判定：manifest 或章节结构坏了是 invalid；正文、Design 闭包或绑定的审稿在 head 下已变是 stale。
 * stale 只表示不能发布，不阻塞作品继续提交。
 */
export async function inspectRelease(
	reader: RevisionHistoryReader,
	headRevisionId: string,
	candidate: ArtifactCandidate,
): Promise<ReleaseStatus> {
	const artifacts = releaseArtifacts(candidate);
	const manifestArtifact = artifacts.find((artifact) => artifact.identity.kind === "release-manifest");
	if (manifestArtifact === undefined) {
		return artifacts.length === 0
			? { state: "missing", chapterCount: 0 }
			: { state: "invalid", chapterCount: 0, reason: "Release chapters exist without a manifest" };
	}
	const invalid = (error: unknown): ReleaseStatus => ({
		state: "invalid",
		chapterCount: 0,
		reason: error instanceof Error ? error.message : String(error),
	});
	let manifest: ReleaseManifest;
	let chapters: { id: string; path: string; text: string }[];
	try {
		manifest = parseReleaseManifest(
			parseYaml(utf8(manifestArtifact, "release/manifest.yaml"), "release/manifest.yaml"),
		);
		chapters = artifacts
			.filter((artifact) => artifact.identity.kind === "release-chapter")
			.map((artifact) => ({
				id: artifact.identity.localId,
				path: `release/chapters/${artifact.identity.localId}.md`,
				text: utf8(artifact, `Release chapter ${artifact.identity.localId}`),
			}));
	} catch (error) {
		return invalid(error);
	}
	const stale = (reason: string): ReleaseStatus => ({
		state: "stale",
		chapterCount: manifest.chapters.length,
		reason,
	});
	let readiness: Awaited<ReturnType<typeof releaseReadiness>>;
	let storyText: ReleaseStoryTextInput[];
	try {
		readiness = await releaseReadiness(reader, headRevisionId, candidate);
		storyText = orderedStoryText(candidate);
	} catch (error) {
		return stale(error instanceof Error ? error.message : String(error));
	}
	const textBlocker = readiness.blockers.find((blocker) => !blocker.startsWith("没有 current 的全书正文审稿"));
	if (textBlocker !== undefined) return stale(textBlocker);
	const verified = verifyRelease(manifest, chapters, storyText);
	if (!verified.passed) return stale(verified.failures[0]?.message ?? "Release does not match current StoryText");
	if (manifest.storyTextReview === undefined) return { state: "current", chapterCount: manifest.chapters.length };
	const review = reviewsIn(candidate).find((item) => item.id === manifest.storyTextReview);
	if (review === undefined) return stale(`审稿 ${manifest.storyTextReview} 已不在作品里`);
	if (review.file.layer !== "text" || review.file.scope.kind !== "book")
		return invalid(new Error(`${manifest.storyTextReview} 不是全书正文审稿`));
	const currency = await reviewCurrency(reader, headRevisionId, candidate, review);
	if (currency.state !== "current") return stale(`审稿 ${manifest.storyTextReview} 已过时`);
	return { state: "current", chapterCount: manifest.chapters.length, reviewVerdict: review.file.draft.verdict };
}
