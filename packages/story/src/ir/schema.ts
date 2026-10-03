import { type TSchema, Type } from "typebox";
import { PROFILE_VERSION, STATE_PROPERTIES } from "./profile.js";

function literals<T extends string>(values: readonly T[]): TSchema {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

export const StateAssignmentSchema = Type.Object(
	{
		subject: Type.String({ minLength: 1 }),
		property: literals(STATE_PROPERTIES),
		value: Type.Union([Type.String({ minLength: 1 }), Type.Boolean()]),
		scope: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const StateChangeSchema = Type.Object(
	{
		story_beat_id: Type.String({ minLength: 1 }),
		assignments: Type.Array(StateAssignmentSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const StateProjectionSchema = Type.Object(
	{
		profile_version: Type.Literal(PROFILE_VERSION),
		initial: Type.Array(StateAssignmentSchema),
		changes: Type.Array(StateChangeSchema),
		authorized_beat_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);
