import { type Static, Type } from "typebox";
import { STORY_BEAT_ID_FRAGMENT, STORY_BEAT_ID_PATTERN, VOLUME_ID_PATTERN } from "./book-patterns.js";
import { IDENTITY_ID_PATTERN, LOCAL_ID_PATTERN } from "./local-id.js";

export const STYLE_REF_PATTERN = "^style_[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$";
export { IDENTITY_ID_PATTERN, LOCAL_ID_PATTERN };
export const INTENT_ID_PATTERN = LOCAL_ID_PATTERN;
export const STORY_CONTRACT_ID_PATTERN = LOCAL_ID_PATTERN;
export const SHA256_PATTERN = "^[a-f0-9]{64}$";
export const STORY_POINT_PATTERN = `^(?:book_end|${STORY_BEAT_ID_FRAGMENT})$`;

export const FAMILY_LINK_KINDS = ["parent", "spouse", "sibling", "guardian"] as const;

const StateValueSchema = Type.Union([Type.String({ minLength: 1 }), Type.Boolean()]);
const StateAssignmentsSchema = Type.Record(Type.String({ minLength: 3 }), StateValueSchema);
const InitialStateSchema = Type.Record(Type.String({ minLength: 2 }), StateValueSchema);
const BeatChangesSchema = Type.Object(
	{
		world: Type.Optional(StateAssignmentsSchema),
		reader: Type.Optional(StateAssignmentsSchema),
		character: Type.Optional(Type.Record(Type.String({ pattern: LOCAL_ID_PATTERN }), StateAssignmentsSchema)),
	},
	{ additionalProperties: false },
);

function literals<T extends string>(values: readonly T[]) {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

function localReferenceArray(pattern = IDENTITY_ID_PATTERN) {
	return Type.Array(Type.String({ pattern }), { minItems: 1, uniqueItems: true });
}

export const SubjectReferenceGroupsSchema = Type.Object(
	{
		character: Type.Optional(localReferenceArray()),
		place: Type.Optional(localReferenceArray()),
		resource: Type.Optional(localReferenceArray()),
		secret: Type.Optional(localReferenceArray()),
		world: Type.Optional(localReferenceArray()),
	},
	{ additionalProperties: false, minProperties: 1 },
);

export const StoryReferenceGroupsSchema = Type.Object(
	{
		character: Type.Optional(localReferenceArray()),
		place: Type.Optional(localReferenceArray()),
		resource: Type.Optional(localReferenceArray()),
		secret: Type.Optional(localReferenceArray()),
		world: Type.Optional(localReferenceArray()),
		beat: Type.Optional(localReferenceArray(STORY_BEAT_ID_PATTERN)),
	},
	{ additionalProperties: false, minProperties: 1 },
);

export type SubjectReferenceGroups = Static<typeof SubjectReferenceGroupsSchema>;
export type StoryReferenceGroups = Static<typeof StoryReferenceGroupsSchema>;

export const StoryIndexYamlSchema = Type.Object(
	{
		schema_version: Type.Literal(2),
		/** 全书未完待续：最后一个 Beat 之后还有故事，`book_end` 的 Contract 不算到期。只在成立时写 true。 */
		open_ended: Type.Optional(Type.Literal(true)),
		volumes: Type.Array(
			Type.Object(
				{
					id: Type.String({ pattern: VOLUME_ID_PATTERN }),
					title: Type.String({ minLength: 1 }),
					beat_ids: Type.Array(Type.String({ pattern: STORY_BEAT_ID_PATTERN }), {
						uniqueItems: true,
					}),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);
export type StoryIndexYaml = Static<typeof StoryIndexYamlSchema>;

export const StoryBeatHeaderSchema = Type.Object(
	{
		title: Type.Optional(Type.String({ minLength: 1 })),
		refs: Type.Optional(StoryReferenceGroupsSchema),
		contracts: Type.Optional(
			Type.Object(
				{
					open: Type.Optional(
						Type.Array(Type.String({ pattern: STORY_CONTRACT_ID_PATTERN }), { uniqueItems: true }),
					),
					advance: Type.Optional(
						Type.Array(Type.String({ pattern: STORY_CONTRACT_ID_PATTERN }), { uniqueItems: true }),
					),
					resolve: Type.Optional(
						Type.Array(Type.String({ pattern: STORY_CONTRACT_ID_PATTERN }), { uniqueItems: true }),
					),
				},
				{ additionalProperties: false },
			),
		),
		changes: Type.Optional(BeatChangesSchema),
	},
	{ additionalProperties: false },
);

export const IdentityHeaderSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1 })),
		aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
		initial: Type.Optional(InitialStateSchema),
	},
	{ additionalProperties: false },
);
export type IdentityHeader = Static<typeof IdentityHeaderSchema>;

export const FamilyLinkSchema = Type.Object(
	{
		kind: literals(FAMILY_LINK_KINDS),
		character: Type.String({ pattern: IDENTITY_ID_PATTERN }),
		role: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const CharacterHeaderSchema = Type.Object(
	{
		name: Type.Optional(Type.String({ minLength: 1 })),
		aliases: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
		family: Type.Optional(Type.Array(FamilyLinkSchema)),
		initial: Type.Optional(InitialStateSchema),
	},
	{ additionalProperties: false },
);
export type CharacterHeader = Static<typeof CharacterHeaderSchema>;

export const StoryContractHeaderSchema = Type.Object(
	{
		subjects: Type.Optional(SubjectReferenceGroupsSchema),
		deadline: Type.Optional(Type.String({ pattern: STORY_POINT_PATTERN })),
	},
	{ additionalProperties: false },
);

export const CreativeIntentSchema = Type.Object(
	{
		applies_to: Type.Optional(Type.Union([Type.Literal("design"), Type.Literal("text")])),
		target: Type.Optional(
			Type.Union([
				Type.Literal("book"),
				Type.Object(
					{
						from_beat_id: Type.String({ pattern: STORY_BEAT_ID_PATTERN }),
						to_beat_id: Type.String({ pattern: STORY_BEAT_ID_PATTERN }),
					},
					{ additionalProperties: false },
				),
			]),
		),
		subjects: Type.Optional(SubjectReferenceGroupsSchema),
		style_refs: Type.Optional(
			Type.Array(Type.String({ pattern: STYLE_REF_PATTERN }), {
				uniqueItems: true,
			}),
		),
	},
	{ additionalProperties: false },
);
export type CreativeIntentHeader = Static<typeof CreativeIntentSchema>;
