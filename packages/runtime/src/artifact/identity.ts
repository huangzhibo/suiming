import { ArtifactError } from "./errors.js";
import type { ArtifactIdentity, ArtifactNamespace } from "./types.js";

function validatePart(value: string, label: string): void {
	if (value.length === 0 || value.includes("\0")) {
		throw new ArtifactError("invalid_artifact_identity", `${label} must be a non-empty string without NUL`);
	}
}

export function targetArtifactIdentity(kind: string, localId: string): ArtifactIdentity {
	return { namespace: { kind: "target" }, kind, localId };
}

export function sourceArtifactIdentity(sourceId: string, kind: string, localId: string): ArtifactIdentity {
	return { namespace: { kind: "source", sourceId }, kind, localId };
}

export function isTargetArtifactIdentity(identity: ArtifactIdentity): boolean {
	return identity.namespace.kind === "target";
}

export function isSourceArtifactIdentity(identity: ArtifactIdentity, sourceId?: string): boolean {
	return identity.namespace.kind === "source" && (sourceId === undefined || identity.namespace.sourceId === sourceId);
}

export function sameArtifactNamespace(left: ArtifactNamespace, right: ArtifactNamespace): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "target" || (right.kind === "source" && left.sourceId === right.sourceId))
	);
}

export function formatArtifactIdentity(identity: ArtifactIdentity): string {
	const prefix = identity.namespace.kind === "target" ? "target" : `source:${identity.namespace.sourceId}`;
	return `${prefix}/${identity.kind}:${identity.localId}`;
}

export function validateArtifactIdentity(identity: ArtifactIdentity): void {
	validatePart(identity.kind, "Artifact kind");
	validatePart(identity.localId, "Artifact localId");
	if (identity.namespace.kind === "source") validatePart(identity.namespace.sourceId, "Source id");
}

export function artifactIdentityKey(identity: ArtifactIdentity): string {
	validateArtifactIdentity(identity);
	const namespace = identity.namespace.kind === "target" ? "target" : `source\0${identity.namespace.sourceId}`;
	return `${namespace}\0${identity.kind}\0${identity.localId}`;
}

export function compareArtifactIdentities(left: ArtifactIdentity, right: ArtifactIdentity): number {
	const leftKey = artifactIdentityKey(left);
	const rightKey = artifactIdentityKey(right);
	return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function copyArtifactIdentity(identity: ArtifactIdentity): ArtifactIdentity {
	return {
		namespace: copyArtifactNamespace(identity.namespace),
		kind: identity.kind,
		localId: identity.localId,
	};
}

function copyArtifactNamespace(namespace: ArtifactNamespace): ArtifactNamespace {
	return namespace.kind === "target" ? { kind: "target" } : { kind: "source", sourceId: namespace.sourceId };
}
