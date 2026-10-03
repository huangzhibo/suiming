import { isLocalId, renderSourceDescriptor, SOURCE_ENCODINGS, type SourceEncoding } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { sourceArtifactIdentity } from "../artifact/identity.js";
import type { InMemoryArtifactStore } from "../artifact/memory-store.js";
import { type InspectedSource, inspectStorySourcesCandidate } from "../artifact/source-validator.js";
import { validateStoryProjectCandidate } from "../artifact/story-design-validator.js";
import type { ProjectRevision } from "../artifact/types.js";

const encoder = new TextEncoder();

export { SOURCE_ENCODINGS };

export interface IngestSourceInput {
	artifactStore: InMemoryArtifactStore;
	projectId: string;
	projectRevisionId: string;
	sourceId: string;
	name: string;
	original: Uint8Array;
	encoding?: string;
}

export interface IngestSourceResult {
	revision: ProjectRevision;
	source: InspectedSource;
}

function requireEncoding(value: string | undefined): SourceEncoding | undefined {
	if (value === undefined) return undefined;
	if (!(SOURCE_ENCODINGS as readonly string[]).includes(value)) {
		throw new ArtifactError("invalid_source_encoding", `不支持的编码：${value}`);
	}
	return value as SourceEncoding;
}

function decodeMaterial(bytes: Uint8Array, encoding: SourceEncoding | undefined): string {
	if (bytes.byteLength === 0) throw new ArtifactError("invalid_source", "Source 输入文件是空的");
	try {
		const material = new TextDecoder(encoding ?? "utf-8", { fatal: true }).decode(bytes);
		if (material.trim().length === 0) {
			throw new ArtifactError("invalid_source", "按所给编码解码后内容为空");
		}
		return material;
	} catch (error) {
		if (error instanceof ArtifactError) throw error;
		throw new ArtifactError(
			"invalid_source_encoding",
			`Source input is not valid ${encoding ?? "utf-8"} text: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function ingestSource(input: IngestSourceInput): IngestSourceResult {
	if (!isLocalId(input.sourceId)) {
		throw new ArtifactError("invalid_source_id", `Source id 不合法：${input.sourceId}`);
	}
	const name = input.name.trim();
	if (name.length === 0) throw new ArtifactError("invalid_source", "Source 名称不能为空");
	const encoding = requireEncoding(input.encoding);
	const candidate = input.artifactStore.snapshotForProject(input.projectId, input.projectRevisionId);
	if (
		candidate.artifacts.some(
			(artifact) =>
				artifact.identity.namespace.kind === "source" && artifact.identity.namespace.sourceId === input.sourceId,
		)
	) {
		throw new ArtifactError("source_already_exists", `Source 已存在：${input.sourceId}`);
	}
	const material = decodeMaterial(input.original, encoding);
	const revision = input.artifactStore.commit(
		input.projectId,
		{
			baseRevisionId: input.projectRevisionId,
			operations: [
				{
					operation: "create",
					identity: sourceArtifactIdentity(input.sourceId, "source-descriptor", "main"),
					path: `source/${input.sourceId}/source.yaml`,
					mediaType: "application/yaml; charset=utf-8",
					bytes: encoder.encode(
						renderSourceDescriptor({ schemaVersion: 1, name, ...(encoding === undefined ? {} : { encoding }) }),
					),
				},
				{
					operation: "create",
					identity: sourceArtifactIdentity(input.sourceId, "source-input", "main"),
					path: `source/${input.sourceId}/original.bin`,
					mediaType: "application/octet-stream",
					bytes: new Uint8Array(input.original),
				},
				{
					operation: "create",
					identity: sourceArtifactIdentity(input.sourceId, "source-material", "main"),
					path: `source/${input.sourceId}/material.txt`,
					mediaType: "text/plain; charset=utf-8",
					bytes: encoder.encode(material),
				},
			],
		},
		validateStoryProjectCandidate,
	);
	const source = inspectStorySourcesCandidate(
		input.artifactStore.snapshotForProject(input.projectId, revision.id),
	).find((item) => item.sourceId === input.sourceId);
	if (source === undefined)
		throw new ArtifactError("source_not_found", `Source not found after ingest: ${input.sourceId}`);
	return { revision, source };
}
