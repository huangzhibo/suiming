import { type TSchema, Type } from "typebox";
import { STATE_PROPERTIES } from "./profile.js";

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
