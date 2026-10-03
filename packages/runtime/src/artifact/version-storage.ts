import { createHash } from "node:crypto";

export function artifactVersionId(mediaType: string, contentHash: string): string {
	return `av_${createHash("sha256").update(mediaType).update("\0").update(contentHash).digest("hex")}`;
}

export function shouldInlineArtifactVersion(mediaType: string, byteLength: number, threshold: number): boolean {
	const base = mediaType.split(";", 1)[0]?.trim().toLowerCase();
	return (
		byteLength <= threshold &&
		(base?.startsWith("text/") === true || base === "application/json" || base === "application/yaml")
	);
}
