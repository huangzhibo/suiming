import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	isBooleanStateProperty,
	isStateProperty,
	PROPERTY_SUBJECT_KINDS,
	PROPERTY_VALUE_KINDS,
	REFERENCE_PATTERN,
	type ReferenceKind,
	SCOPED_STATE_PROPERTIES,
	type StateProperty,
} from "./profile.js";
import { StateAssignmentSchema } from "./schema.js";
import type { StateAssignment, StateValue } from "./types.js";

function checked<T extends TSchema>(schema: T, input: unknown, label: string): Static<T> {
	if (!Value.Check(schema, input)) {
		const issue = [...Value.Errors(schema, input)][0];
		throw new Error(`${label}${issue?.instancePath ?? ""}: ${issue?.message ?? "does not match schema"}`);
	}
	return input as Static<T>;
}

function asRecord(input: unknown, label: string): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new Error(`${label} must be an object`);
	}
	return input as Record<string, unknown>;
}

function asString(input: unknown, label: string): string {
	if (typeof input !== "string" || input.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return input;
}

function asStateValue(input: unknown, label: string): StateValue {
	if (typeof input !== "string" && typeof input !== "boolean") {
		throw new Error(`${label} must be a string or boolean`);
	}
	if (typeof input === "string" && input.length === 0) {
		throw new Error(`${label} must not be empty`);
	}
	return input;
}

export function referenceKind(value: string): ReferenceKind {
	const match = REFERENCE_PATTERN.exec(value);
	const kind = match?.groups?.kind;
	const id = match?.groups?.id;
	const hasControlCharacter =
		id !== undefined &&
		[...id].some((character) => {
			const codePoint = character.codePointAt(0);
			return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
		});
	if (match === null || kind === undefined || id === undefined || id !== id.normalize("NFC") || hasControlCharacter) {
		throw new Error(`invalid typed reference: ${value}`);
	}
	return kind as ReferenceKind;
}

function validateScope(scope: string): void {
	if (scope === "world" || scope === "reader") {
		return;
	}
	if (scope.startsWith("character:") && referenceKind(scope) === "character") {
		return;
	}
	throw new Error(`unsupported state scope: ${scope}`);
}

export function parseStateAssignment(input: unknown): StateAssignment {
	checked(StateAssignmentSchema, input, "state assignment");
	const raw = asRecord(input, "state assignment");
	const subject = asString(raw.subject, "subject");
	const propertyRaw = asString(raw.property, "property");
	if (!isStateProperty(propertyRaw)) {
		throw new Error(`unsupported state property: ${propertyRaw}`);
	}
	const property: StateProperty = propertyRaw;
	const value = asStateValue(raw.value, "value");
	const scope = raw.scope === undefined ? "world" : asString(raw.scope, "scope");
	validateScope(scope);

	const subjectKind = referenceKind(subject);
	if (!PROPERTY_SUBJECT_KINDS[property].includes(subjectKind)) {
		throw new Error(`${property} does not apply to ${subjectKind}`);
	}
	if (scope !== "world" && !(SCOPED_STATE_PROPERTIES as readonly string[]).includes(property)) {
		throw new Error(
			`${scope} scope only carries secret ${SCOPED_STATE_PROPERTIES.join(" / ")}; ${property} is objective world state`,
		);
	}
	if (isBooleanStateProperty(property)) {
		if (typeof value !== "boolean") {
			throw new Error(`${property} requires a boolean value`);
		}
	} else {
		if (typeof value !== "string") {
			throw new Error(`${property} requires a typed reference or none`);
		}
		if (value !== "none") {
			const expected = PROPERTY_VALUE_KINDS[property];
			if (expected === undefined || referenceKind(value) !== expected) {
				throw new Error(`${property} requires ${expected ?? "a supported reference"} or none`);
			}
		}
	}
	return { subject, property, value, scope };
}
