import { isLocalId, renderSourceDescriptor, SOURCE_ENCODINGS, type SourceEncoding } from "@suiming/story";
import { ArtifactError } from "../artifact/errors.js";
import { sourceArtifactIdentity } from "../artifact/identity.js";
import type { ArtifactCandidate, ChangeSet } from "../artifact/types.js";

const encoder = new TextEncoder();

export { SOURCE_ENCODINGS };

export interface IngestSourceInput {
	sourceId: string;
	name: string;
	original: Uint8Array;
	encoding?: string;
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

/**
 * 导入一份原作：原始字节原样保存，另按编码解码出 UTF-8 的 material。只构造 ChangeSet，校验与提交走调用方的
 * 提交路径（本地是 `commitManagedChangeSet`，过 Checker 才推进 Canon）。
 */
export function sourceIngestChangeSet(base: ArtifactCandidate, input: IngestSourceInput): ChangeSet {
	if (!isLocalId(input.sourceId)) {
		throw new ArtifactError("invalid_source_id", `Source id 不合法：${input.sourceId}`);
	}
	const name = input.name.trim();
	if (name.length === 0) throw new ArtifactError("invalid_source", "Source 名称不能为空");
	const encoding = requireEncoding(input.encoding);
	if (
		base.artifacts.some(
			(artifact) =>
				artifact.identity.namespace.kind === "source" && artifact.identity.namespace.sourceId === input.sourceId,
		)
	) {
		throw new ArtifactError("source_already_exists", `Source 已存在：${input.sourceId}`);
	}
	const material = decodeMaterial(input.original, encoding);
	return {
		baseRevisionId: base.baseRevisionId,
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
	};
}
