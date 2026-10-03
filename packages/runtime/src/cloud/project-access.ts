import { CloudStoreError } from "./errors.js";

export const CLOUD_PROJECT_ROLES = ["owner", "editor", "viewer"] as const;
export type CloudProjectRole = (typeof CLOUD_PROJECT_ROLES)[number];

export const CLOUD_PROJECT_CAPABILITIES = ["project.read", "project.write", "project.manage"] as const;
export type CloudProjectCapability = (typeof CLOUD_PROJECT_CAPABILITIES)[number];

const CAPABILITIES_BY_ROLE: Readonly<Record<CloudProjectRole, ReadonlySet<CloudProjectCapability>>> = {
	owner: new Set(CLOUD_PROJECT_CAPABILITIES),
	editor: new Set(["project.read", "project.write"]),
	viewer: new Set(["project.read"]),
};

export function canUseCloudProjectCapability(
	role: CloudProjectRole | undefined,
	capability: CloudProjectCapability,
): boolean {
	return role !== undefined && CAPABILITIES_BY_ROLE[role].has(capability);
}

export function assertCloudProjectCapability(
	role: CloudProjectRole | undefined,
	capability: CloudProjectCapability,
): asserts role is CloudProjectRole {
	if (!canUseCloudProjectCapability(role, capability)) {
		throw new CloudStoreError("cloud_access_denied", `Project role cannot use capability ${capability}`);
	}
}
