import {
	type BoundSource,
	bindSourceDocuments,
	checkSource,
	isLocalId,
	parseSourceDescriptor,
	parseSourceNote,
	parseYaml,
	type SourceCheckResult,
	type SourceDescriptor,
	type SourceExtractionDocuments,
} from "@suiming/story";
import { codePointCount } from "./code-points.js";
import { ArtifactError } from "./errors.js";
import { isSourceArtifactIdentity } from "./identity.js";
import type { ArtifactCandidate, CandidateArtifact } from "./types.js";

export interface InspectedSource {
	sourceId: string;
	state: "ingested" | "extracted";
	descriptor: SourceDescriptor;
	originalByteLength: number;
	materialCodePoints: number;
	check?: SourceCheckResult;
}

function text(artifact: CandidateArtifact, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
	} catch {
		throw new ArtifactError("invalid_utf8", `${path} 不是 UTF-8 文本`);
	}
}

function required(artifacts: readonly CandidateArtifact[], kind: string, sourceId: string): CandidateArtifact {
	const artifact = artifacts.find((item) => item.identity.kind === kind && item.identity.localId === "main");
	if (artifact === undefined) {
		throw new ArtifactError("source_artifact_missing", `Source ${sourceId} is missing ${kind}`);
	}
	return artifact;
}

interface BoundSourceParts {
	descriptor: SourceDescriptor;
	originalByteLength: number;
	materialCodePoints: number;
	/** 还没有 extraction 时没有。 */
	bound?: BoundSource;
}

function inspectSource(candidate: ArtifactCandidate, sourceId: string): InspectedSource {
	const { bound, ...parts } = bindSource(candidate, sourceId);
	return bound === undefined
		? { sourceId, state: "ingested", ...parts }
		: { sourceId, state: "extracted", ...parts, check: checkSource(bound) };
}

/**
 * 一份 Source 抽取出来的 Design：与 Target 同一套语义（BoundDesign 就是 BoundBook），所以 impact 这类查询能原样复用。
 * 还没有抽取时报 `source_not_extracted`。
 */
export function sourceExtractionDesign(candidate: ArtifactCandidate, sourceId: string): BoundSource["extraction"] {
	const { bound } = bindSource(candidate, sourceId);
	if (bound === undefined)
		throw new ArtifactError("source_not_extracted", `Source ${sourceId} 还没有抽取（没有 outline/story/index.yaml）`);
	return bound.extraction;
}

function bindSource(candidate: ArtifactCandidate, sourceId: string): BoundSourceParts {
	if (!isLocalId(sourceId)) throw new ArtifactError("invalid_source_id", `Invalid Source id: ${sourceId}`);
	const artifacts = candidate.artifacts.filter((artifact) => isSourceArtifactIdentity(artifact.identity, sourceId));
	const descriptorArtifact = required(artifacts, "source-descriptor", sourceId);
	const inputArtifact = required(artifacts, "source-input", sourceId);
	const materialArtifact = required(artifacts, "source-material", sourceId);
	const descriptorPath = descriptorArtifact.path;
	const materialPath = materialArtifact.path;
	const descriptor = parseSourceDescriptor(
		parseYaml(text(descriptorArtifact, descriptorPath), descriptorPath),
		descriptorPath,
	);
	const material = text(materialArtifact, materialPath);
	if (inputArtifact.bytes.byteLength === 0) {
		throw new ArtifactError("invalid_source", `source/${sourceId}/original.bin must not be empty`);
	}
	if (material.trim().length === 0) {
		throw new ArtifactError("invalid_source", `${materialPath} must not be empty`);
	}

	// 读材料留下的笔记是普通文件：只查形状，覆盖率由 derived 按 span 算；它们不算 extraction。
	for (const note of artifacts.filter((artifact) => artifact.identity.kind === "source-note")) {
		const path = note.path;
		parseSourceNote(text(note, path), path);
	}
	const extractionArtifacts = artifacts.filter(
		(artifact) =>
			!["source-descriptor", "source-input", "source-material", "source-note"].includes(artifact.identity.kind),
	);
	const index = extractionArtifacts.find(
		(artifact) => artifact.identity.kind === "story-index" && artifact.identity.localId === "main",
	);
	if (index === undefined) {
		if (extractionArtifacts.length > 0) {
			throw new ArtifactError(
				"source_story_index_missing",
				`Source ${sourceId} extraction has artifacts but no outline/story/index.yaml`,
			);
		}
		return {
			descriptor,
			originalByteLength: inputArtifact.bytes.byteLength,
			materialCodePoints: codePointCount(material),
		};
	}

	let storyIndex: unknown;
	const beats: SourceExtractionDocuments["beats"][number][] = [];
	const characters: SourceExtractionDocuments["characters"][number][] = [];
	const places: SourceExtractionDocuments["places"][number][] = [];
	const resources: SourceExtractionDocuments["resources"][number][] = [];
	const world: SourceExtractionDocuments["world"][number][] = [];
	const contracts: SourceExtractionDocuments["contracts"][number][] = [];
	for (const artifact of extractionArtifacts) {
		const path = artifact.path;
		switch (artifact.identity.kind) {
			case "story-index":
				storyIndex = parseYaml(text(artifact, path), path);
				break;
			case "story-beat": {
				const volumeId = path.split("/")[4];
				if (volumeId === undefined)
					throw new ArtifactError("invalid_story_beat_path", `Invalid Source StoryBeat path: ${path}`);
				beats.push({
					volumeId,
					beatId: artifact.identity.localId,
					path,
					markdown: text(artifact, path),
				});
				break;
			}
			case "story-contract":
				contracts.push({ id: artifact.identity.localId, path, markdown: text(artifact, path) });
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
				const body = text(artifact, path).trim();
				if (body.length === 0) throw new ArtifactError("invalid_document", `${path} 是空文件`);
				world.push({ id: artifact.identity.localId, path, body });
				break;
			}
			default:
				throw new ArtifactError(
					"unsupported_source_artifact",
					`Unsupported extraction artifact in Source ${sourceId}: ${artifact.identity.kind}`,
				);
		}
	}
	const bound = bindSourceDocuments(sourceId, {
		descriptor: {
			schema_version: 1,
			name: descriptor.name,
			...(descriptor.encoding ? { encoding: descriptor.encoding } : {}),
		},
		original: inputArtifact.bytes,
		material,
		extraction: {
			storyIndex,
			beats,
			characters,
			places,
			resources,
			world,
			contracts,
		},
	});
	return {
		descriptor,
		originalByteLength: inputArtifact.bytes.byteLength,
		materialCodePoints: codePointCount(material),
		bound,
	};
}

export function inspectStorySourcesCandidate(candidate: ArtifactCandidate): InspectedSource[] {
	const sourceIds = new Set<string>();
	for (const artifact of candidate.artifacts) {
		if (artifact.identity.namespace.kind === "source") sourceIds.add(artifact.identity.namespace.sourceId);
	}
	return [...sourceIds].sort().map((sourceId) => inspectSource(candidate, sourceId));
}
