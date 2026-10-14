import { formatDiagnostic } from "@suiming/story";
import { isSourceArtifactIdentity } from "../artifact/identity.js";
import { inspectStorySourcesCandidate } from "../artifact/source-validator.js";
import type { ArtifactCandidate, ArtifactIdentity } from "../artifact/types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
// 笔记是读材料的 handoff，不是 extraction；它们按顺序渲染在 Review 输入的前半段。
const SOURCE_FIXED_KINDS = new Set(["source-descriptor", "source-input", "source-material", "source-note"]);

export function renderSourceExtraction(candidate: ArtifactCandidate, sourceId: string): string {
	const files = candidate.artifacts
		.filter(
			(artifact) =>
				isSourceArtifactIdentity(artifact.identity, sourceId) && !SOURCE_FIXED_KINDS.has(artifact.identity.kind),
		)
		.map((artifact) => ({ path: artifact.path, artifact }))
		.sort((left, right) => left.path.localeCompare(right.path));
	if (files.length === 0) return "（尚无 extraction 文件）";
	return files
		.map(
			({ path, artifact }) =>
				`--- BEGIN ARTIFACT ${JSON.stringify(path)} ---\n${decoder.decode(artifact.bytes)}\n--- END ARTIFACT ${JSON.stringify(path)} ---`,
		)
		.join("\n\n");
}

/** 补全只预载本段。跨段引用和后文必须按需回读，不能让全书体积乘上委派数。 */
export function renderSourceRange(
	candidate: ArtifactCandidate,
	sourceId: string,
	range: { from: number; to: number },
): string {
	let remaining = 48 * 1024;
	const files = candidate.artifacts
		.filter((artifact) => {
			if (!isSourceArtifactIdentity(artifact.identity, sourceId) || artifact.identity.kind !== "story-beat")
				return false;
			const number = Number(/^beat-(\d+)$/u.exec(artifact.identity.localId)?.[1]);
			return number >= range.from && number <= range.to;
		})
		.sort((a, b) => a.path.localeCompare(b.path));
	return [
		`本段抽取（不是全书）：先 read source/${sourceId}/outline/story/index.yaml 了解卷序；结合本段人物、期待与秘密，用 search / read 查后文揭示和跨段关联。不能把未预载当成不存在。`,
		...files.map((file) => {
			const content = `--- BEGIN ARTIFACT ${JSON.stringify(file.path)} ---\n${decoder.decode(file.bytes)}\n--- END ARTIFACT ---`;
			const size = Buffer.byteLength(content);
			if (size > remaining) return `按需读取：${file.path}`;
			remaining -= size;
			return content;
		}),
	].join("\n\n");
}

export function sourceExtractionSelections(
	candidate: ArtifactCandidate,
	sourceId: string,
): { identity: ArtifactIdentity }[] {
	return candidate.artifacts
		.filter(
			(artifact) =>
				isSourceArtifactIdentity(artifact.identity, sourceId) && !SOURCE_FIXED_KINDS.has(artifact.identity.kind),
		)
		.map((artifact) => ({ identity: artifact.identity }));
}

export function formatSourceCheck(candidate: ArtifactCandidate, sourceId: string): string {
	let sources: ReturnType<typeof inspectStorySourcesCandidate>;
	try {
		sources = inspectStorySourcesCandidate(candidate);
	} catch (error) {
		return `FAILED ${(error as { code?: string }).code ?? "check_failed"}: ${error instanceof Error ? error.message : String(error)}`;
	}
	const source = sources.find((item) => item.sourceId === sourceId);
	if (source === undefined) return `FAILED source_not_found: ${sourceId}`;
	if (source.state !== "extracted" || source.check === undefined) {
		return "FAILED source_not_extracted: 还没有 outline/story/index.yaml 或 extraction 尚未完整";
	}
	const lines = [
		source.check.passed ? "PASSED" : "FAILED",
		...source.check.diagnostics.map((item) => `- ${formatDiagnostic(item)}`),
		...(source.check.contracts.openContractIds.length === 0
			? []
			: [`材料边界内未闭合的 Contract：${source.check.contracts.openContractIds.join(", ")}`]),
		...(source.check.warnings.length === 0
			? []
			: ["warnings：", ...source.check.warnings.map((item) => `- warning: ${formatDiagnostic(item)}`)]),
	];
	return lines.join("\n");
}
