import { ArtifactError } from "./errors.js";
import type { ArtifactCandidate, ArtifactIdentity } from "./types.js";

export interface OpenPackageFile {
	path: string;
	mediaType: string;
	bytes: Uint8Array;
}

export interface ArtifactPathCodec {
	identityForPath(path: string): ArtifactIdentity;
	pathForIdentity(identity: ArtifactIdentity, candidate: ArtifactCandidate): string;
}

export function validateOpenPackagePath(path: string): void {
	if (
		path.length === 0 ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new ArtifactError("invalid_logical_path", `Invalid open-package path: ${path}`);
	}
}
