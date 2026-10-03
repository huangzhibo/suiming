import { randomBytes } from "node:crypto";
import {
	parseReviewDraft,
	type ReviewDraft,
	type ReviewFile,
	type ReviewLayer,
	type ReviewScope,
	renderReviewFile,
} from "@suiming/story";
import { reviewSubjectPaths, subjectDigests } from "./derived.js";
import { ArtifactError } from "./errors.js";
import { isSourceArtifactIdentity, isTargetArtifactIdentity } from "./identity.js";
import { sourceMaterialFromCandidate } from "./source-material.js";
import { inspectStoryDesignCandidate } from "./story-design-validator.js";
import type { ArtifactCandidate } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ComposeReviewInput {
	layer: ReviewLayer;
	scope: ReviewScope;
	/** 审的是哪个 Canon revision。 */
	revision: string;
	/** Reviewer 的 ReviewDraft，按 Story Language schema 严格解析。 */
	draft: unknown;
	now?: Date;
}

export interface ComposedReview {
	id: string;
	path: string;
	content: string;
	file: ReviewFile;
}

function timestampId(now: Date): string {
	const iso = now
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "");
	return `${iso.slice(0, 8)}-${iso.slice(9, 15)}`;
}

function textOf(candidate: ArtifactCandidate, path: string): string | undefined {
	const artifact = candidate.artifacts.find((item) => {
		try {
			return item.path === path;
		} catch {
			return false;
		}
	});
	if (artifact === undefined) return undefined;
	try {
		return decoder.decode(artifact.bytes);
	} catch {
		return undefined;
	}
}

/** 比较前去掉空白与引号，模型转述时最常改的就是这两样；标点保留，否则短引文会误命中。与 `apps/web/src/anchors.ts` 同一规则。 */
function normalize(text: string): string {
	return text.replace(/\s+/gu, "").replace(/[「」“”"『』‘’']/gu, "");
}

const QUOTE = /[「“"『]([^」”"』]{2,})[」”"』]/gu;

/**
 * 引文必须逐字出自被审文件（[Harness 设计](../../../../docs/harness-design.md)第 6 节）：审稿页把 finding 锚回段落靠的
 * 就是这段引文，Reviewer 转述一句就锚不上。规则与渲染端的 `quotedFragments` 一致：evidence 里有引号就要求每段引文都在原文里；
 * 没有引号时至少一个 8 字以上的句子要在原文里；连这样的句子都没有就要求整段 evidence 在原文里。
 */
function quoteMissing(evidence: string, content: string): boolean {
	const text = normalize(content);
	const quoted = [...evidence.matchAll(QUOTE)].map((match) => normalize(match[1] ?? ""));
	if (quoted.length > 0) return quoted.some((fragment) => !text.includes(fragment));
	const sentences = evidence
		.split(/[。！？；\n]/u)
		.map((sentence) => normalize(sentence))
		.filter((sentence) => sentence.length >= 8);
	if (sentences.length > 0) return !sentences.some((sentence) => text.includes(sentence));
	return !text.includes(normalize(evidence));
}

function requireQuote(candidate: ArtifactCandidate, draft: ReviewDraft, scope: ReviewScope): void {
	// Source 层的真源是原作：「抽取写成 A、原作是 B」「人物档漏了原作的 X」要修的是抽取文件，证据却在原作里。
	// 锚在抽取文件上的 finding 因此也可以引原作，两边都能逐字核对；只引原作时审稿页退回到只锚文件。
	const sourceId = scope.kind === "source" ? scope.sourceId : undefined;
	const material = sourceId === undefined ? undefined : sourceMaterialFromCandidate(candidate, sourceId).text;
	for (const [index, finding] of draft.findings.entries()) {
		if (finding.anchor.kind === "artifact") {
			const content = textOf(candidate, finding.anchor.path);
			if (content === undefined)
				throw new ArtifactError(
					"review_anchor_not_found",
					`finding ${index + 1} 锚定的 ${finding.anchor.path} 不在作品里`,
				);
			// \0 隔开两份文本，引文不会跨界命中
			if (quoteMissing(finding.evidence, material === undefined ? content : `${content}\0${material}`))
				throw new ArtifactError(
					"review_quote_not_found",
					material === undefined
						? `finding ${index + 1} 的引文不是 ${finding.anchor.path} 里的原文：${finding.evidence.slice(0, 40)}…`
						: `finding ${index + 1} 的引文既不在 ${finding.anchor.path} 里，也不在 source/${sourceId} 的原作里：${finding.evidence.slice(0, 40)}…`,
				);
		} else {
			const view = sourceMaterialFromCandidate(candidate, finding.anchor.sourceId);
			const span = [...view.text].slice(finding.anchor.start, finding.anchor.end).join("");
			if (quoteMissing(finding.evidence, span))
				throw new ArtifactError(
					"review_quote_not_found",
					`finding ${index + 1} 的引文不在 source/${finding.anchor.sourceId} 的 [${finding.anchor.start}, ${finding.anchor.end}) 里`,
				);
		}
	}
}

function requireScope(candidate: ArtifactCandidate, layer: ReviewLayer, scope: ReviewScope): void {
	if (scope.kind === "beats") {
		const known = new Set(inspectStoryDesignCandidate(candidate).design.story.beats.map((beat) => beat.id));
		const unknown = scope.storyBeatIds.filter((id) => !known.has(id));
		if (unknown.length > 0)
			throw new ArtifactError("story_beat_not_found", `Unknown StoryBeat: ${unknown.join(", ")}`);
		if (layer !== "text") throw new ArtifactError("invalid_review_subject", `${layer} 审稿的范围只能是 book`);
	}
	if (scope.kind === "source") {
		if (layer !== "source") throw new ArtifactError("invalid_review_subject", `${layer} 审稿不能指向 Source`);
		if (!candidate.artifacts.some((artifact) => isSourceArtifactIdentity(artifact.identity, scope.sourceId)))
			throw new ArtifactError("source_not_found", `Source not found: ${scope.sourceId}`);
	}
	if (layer === "source" && scope.kind !== "source")
		throw new ArtifactError("invalid_review_subject", "source 审稿需要 sourceId");
}

/** 校验并渲染一份审稿文件；写进作品目录由调用方负责（Reviewer 经 write，host 经 `suim review record`）。 */
export function composeReviewFile(candidate: ArtifactCandidate, input: ComposeReviewInput): ComposedReview {
	const draft = parseReviewDraft(input.draft);
	requireScope(candidate, input.layer, input.scope);
	requireQuote(candidate, draft, input.scope);
	const now = input.now ?? new Date();
	const id = `${input.layer}-${timestampId(now)}-${randomBytes(2).toString("hex")}`;
	if (
		candidate.artifacts.some(
			(artifact) =>
				isTargetArtifactIdentity(artifact.identity) &&
				artifact.identity.kind === "review" &&
				artifact.identity.localId === id,
		)
	)
		throw new ArtifactError("review_exists", `review/${id}.md 已存在`);
	// 审的时候主体文件长什么样，写进文件——时效比的是它，不是审稿何时进版本。
	const subjects = subjectDigests(candidate, reviewSubjectPaths(candidate, input.layer, input.scope));
	const file: ReviewFile = { layer: input.layer, scope: input.scope, revision: input.revision, subjects, draft };
	return { id, path: `review/${id}.md`, content: renderReviewFile(file), file };
}
