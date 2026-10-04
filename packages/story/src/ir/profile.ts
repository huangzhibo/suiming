export const PROFILE_VERSION = "state-projection-p0@2" as const;

export const REFERENCE_KINDS = ["character", "place", "resource", "secret"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const STATE_PROPERTIES = [
	"location",
	"holder",
	"dead",
	"incapacitated",
	"imprisoned",
	"accessible",
	"secured",
	"consumed",
	"destroyed",
	"sealed",
	"installed",
	"revealed",
] as const;
export type StateProperty = (typeof STATE_PROPERTIES)[number];

export const BOOLEAN_STATE_PROPERTIES = [
	"dead",
	"incapacitated",
	"imprisoned",
	"accessible",
	"secured",
	"consumed",
	"destroyed",
	"sealed",
	"installed",
	"revealed",
] as const satisfies readonly StateProperty[];

/** `reader` 与 `character` 作用域只表达「谁知道了什么」，只放这些属性；其余都是客观世界状态，写在 `world`。 */
export const SCOPED_STATE_PROPERTIES = ["revealed"] as const satisfies readonly StateProperty[];

export const PROPERTY_SUBJECT_KINDS: Readonly<Record<StateProperty, readonly ReferenceKind[]>> = {
	location: ["character", "resource"],
	holder: ["resource"],
	dead: ["character"],
	incapacitated: ["character"],
	imprisoned: ["character"],
	accessible: ["place"],
	secured: ["place"],
	consumed: ["resource"],
	destroyed: ["resource"],
	sealed: ["resource"],
	installed: ["resource"],
	revealed: ["secret"],
};

export const PROPERTY_VALUE_KINDS: Readonly<Partial<Record<StateProperty, ReferenceKind>>> = {
	location: "place",
	holder: "character",
};

export const TERMINAL_RESOURCE_PROPERTIES = ["consumed", "destroyed"] as const satisfies readonly StateProperty[];

export const STEP_ERROR_CODES = [
	"change_outside_story",
	"change_order_invalid",
	"dead_state_reversed",
	"terminal_resource_reused",
	"conflicting_assignment",
] as const;
export type StepErrorCode = (typeof STEP_ERROR_CODES)[number];

export const REFERENCE_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: wire references must reject filesystem control characters at the schema boundary.
	/^(?<kind>character|place|resource|secret):(?<id>(?!.*\.$)[^\s<>:"/\\|?*\u0000-\u001f\u007f.][^\s<>:"/\\|?*\u0000-\u001f\u007f]{0,298})$/u;

export function isStateProperty(value: string): value is StateProperty {
	return (STATE_PROPERTIES as readonly string[]).includes(value);
}

export function isBooleanStateProperty(value: StateProperty): boolean {
	return (BOOLEAN_STATE_PROPERTIES as readonly StateProperty[]).includes(value);
}
