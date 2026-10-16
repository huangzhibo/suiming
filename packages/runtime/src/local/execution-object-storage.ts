import { createHash } from "node:crypto";

export function executionObjectId(mediaType: string, contentHash: string): string {
	return `eo_${createHash("sha256").update(mediaType).update("\0").update(contentHash).digest("hex")}`;
}

export function shouldInlineExecutionObject(mediaType: string, byteLength: number, threshold: number): boolean {
	const base = mediaType.split(";", 1)[0]?.trim().toLowerCase();
	return (
		byteLength <= threshold &&
		(base?.startsWith("text/") === true || base === "application/json" || base === "application/yaml")
	);
}
