import {
	type BoundDesign,
	bindDesignDocuments,
	checkDesign,
	type DesignCheckResult,
	type DesignDocuments,
	type Diagnostic,
	parseReviewFile,
	parseYaml,
	type ReviewFile,
	type StoryTextDocument,
	type StoryTextVerificationResult,
	verifyStoryText,
} from "@suiming/story";
import { ArtifactError } from "./errors.js";
import { isTargetArtifactIdentity } from "./identity.js";
import { unrecognizedStoryPathsError } from "./open-story-directory.js";
import { validateReleaseArtifactsCandidate } from "./release-validator.js";
import { type InspectedSource, inspectStorySourcesCandidate } from "./source-validator.js";
import type { ArtifactCandidate, CandidateArtifact } from "./types.js";

function text(artifact: CandidateArtifact, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
	} catch {
		throw new ArtifactError("invalid_utf8", `${path} 不是 UTF-8 文本`);
	}
}

export interface InspectedStoryProject {
	design: BoundDesign;
	check: DesignCheckResult;
	storyText: StoryTextVerificationResult;
	sources: InspectedSource[];
}

export interface InspectedStoryDesign {
	design: BoundDesign;
	check: DesignCheckResult;
}

export function inspectStoryDesignCandidate(candidate: ArtifactCandidate): InspectedStoryDesign {
	let storyIndex: unknown;
	const beats: DesignDocuments["beats"][number][] = [];
	const characters: DesignDocuments["characters"][number][] = [];
	const places: DesignDocuments["places"][number][] = [];
	const resources: DesignDocuments["resources"][number][] = [];
	const world: DesignDocuments["world"][number][] = [];
	const contracts: DesignDocuments["contracts"][number][] = [];
	const intents: DesignDocuments["intents"][number][] = [];
	const styleIds: string[] = [];
	const reviews: { path: string; file: ReviewFile }[] = [];

	for (const artifact of candidate.artifacts) {
		if (!isTargetArtifactIdentity(artifact.identity)) continue;
		const path = artifact.path;
		switch (artifact.identity.kind) {
			case "story-index": {
				const content = text(artifact, path);
				storyIndex = parseYaml(content, path);
				break;
			}
			case "story-beat": {
				const content = text(artifact, path);
				const volumeId = path.split("/")[2];
				if (volumeId === undefined)
					throw new ArtifactError("invalid_story_beat_path", `StoryBeat 路径不合法：${path}`);
				beats.push({
					volumeId,
					beatId: artifact.identity.localId,
					path,
					markdown: content,
				});
				break;
			}
			case "story-contract":
				contracts.push({ id: artifact.identity.localId, path, markdown: text(artifact, path) });
				break;
			case "intent":
				intents.push({ id: artifact.identity.localId, path, markdown: text(artifact, path) });
				break;
			case "character":
				characters.push({ id: artifact.identity.localId, path, markdown: text(artifact, path) });
				break;
			case "place":
				places.push({ id: artifact.identity.localId, path, markdown: text(artifact, path) });
				break;
			case "resource":
				resources.push({ id: artifact.identity.localId, path, markdown: text(artifact, path) });
				break;
			case "world": {
				const content = text(artifact, path);
				const body = content.trim();
				if (body.length === 0) throw new ArtifactError("invalid_document", `${path} 是空文件`);
				world.push({ id: artifact.identity.localId, path, body });
				break;
			}
			case "style-evidence":
				styleIds.push(artifact.identity.localId);
				break;
			case "review":
				// 审稿是普通作品文件：Checker 只查它的形状；它审的 revision 是否在历史里由写入方核对。
				reviews.push({ path, file: parseReviewFile(text(artifact, path), path) });
				break;
			default:
				break;
		}
	}

	if (storyIndex === undefined) {
		throw new ArtifactError("story_index_not_found", "作品缺少 outline/story/index.yaml");
	}
	const documents: DesignDocuments = {
		storyIndex,
		beats,
		characters,
		places,
		resources,
		world,
		contracts,
		intents,
		styleIds,
	};
	const design = bindDesignDocuments(documents);
	const check = checkDesign(design);
	const beatIds = new Set(design.story.beats.map((beat) => beat.id));
	for (const review of reviews) {
		if (review.file.scope.kind !== "beats") continue;
		const unknown = review.file.scope.storyBeatIds.filter((id) => !beatIds.has(id));
		if (unknown.length > 0)
			throw new ArtifactError("review_scope_unknown_beat", `${review.path} 审的 Beat 不存在：${unknown.join("、")}`);
	}
	return { design, check };
}

export function inspectStoryProjectCandidate(candidate: ArtifactCandidate): InspectedStoryProject {
	const inspected = inspectStoryDesignCandidate(candidate);
	const storyTextDocuments: StoryTextDocument[] = candidate.artifacts
		.filter((artifact) => isTargetArtifactIdentity(artifact.identity) && artifact.identity.kind === "story-text")
		.map((artifact) => {
			const path = artifact.path;
			return { storyBeatId: artifact.identity.localId, text: text(artifact, path) };
		});
	const storyText = verifyStoryText(inspected.design.story, inspected.design.intents, storyTextDocuments);
	const sources = inspectStorySourcesCandidate(candidate);
	return { ...inspected, storyText, sources };
}

function validateDesignState(inspected: InspectedStoryDesign): void {
	if (inspected.check.state.passed) return;
	throw new ArtifactError(
		"story_state_check_failed",
		inspected.check.state.failures.map((failure) => failure.message).join("; ") || "Story hard-state check failed",
	);
}

export function validateStoryProjectCandidate(candidate: ArtifactCandidate): InspectedStoryProject {
	if (candidate.unrecognizedPaths !== undefined && candidate.unrecognizedPaths.length > 0)
		throw unrecognizedStoryPathsError(candidate.unrecognizedPaths);
	const validated = inspectStoryProjectCandidate(candidate);
	validateReleaseArtifactsCandidate(candidate);
	validateDesignState(validated);
	const orphan = validated.storyText.failures.find((failure) => failure.code === "orphan_text");
	if (orphan !== undefined) {
		throw new ArtifactError("orphan_story_text", orphan.message);
	}
	const invalidSourceState = validated.sources.find(
		(source) => source.check !== undefined && !source.check.state.passed,
	);
	if (invalidSourceState !== undefined) {
		throw new ArtifactError(
			"source_state_check_failed",
			invalidSourceState.check?.state.failures.map((failure) => failure.message).join("; ") ||
				`Source ${invalidSourceState.sourceId} hard-state check failed`,
		);
	}
	return validated;
}

/**
 * 提交拦不住、但要修的问题。能不能提交只看 validateStoryProjectCandidate（绑定、硬状态、孤儿正文、
 * Source 硬状态）；设计层错误（Contract 没兑现、秘密先揭示后声明）、Source 抽取的错误与已有正文的问题
 * （空正文、逐字意图缺失）不拦阶段提交，是这里的另一半。CLI、桌面与 Agent 的 check 都按它说「通过」与否，
 * 免得同一份候选在一处说通过、另一处说未通过。`missing_text` 只表示全书还没写完，不算。
 */
export function checkFindings(inspected: InspectedStoryProject): {
	errors: Diagnostic[];
	warnings: Diagnostic[];
	textFailures: StoryTextVerificationResult["failures"];
} {
	const sources = inspected.sources.flatMap((source) => (source.check === undefined ? [] : [source.check]));
	return {
		errors: [...inspected.check.diagnostics, ...sources.flatMap((check) => check.diagnostics)],
		warnings: [...inspected.check.warnings, ...sources.flatMap((check) => check.warnings)],
		textFailures: inspected.storyText.failures.filter((failure) => failure.code !== "missing_text"),
	};
}

export function validateCompleteStoryTextCandidate(candidate: ArtifactCandidate): InspectedStoryProject {
	const validated = validateStoryProjectCandidate(candidate);
	if (!validated.storyText.passed) {
		const failure = validated.storyText.failures[0];
		throw new ArtifactError("story_text_check_failed", failure?.message ?? "StoryText check failed");
	}
	return validated;
}
