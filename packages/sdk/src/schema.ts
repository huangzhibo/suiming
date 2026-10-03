import { type Static, type TSchema, Type } from "typebox";

export const SUIMING_DOMAIN_API_VERSION = "suiming.domain.v1" as const;

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" });
const LogicalPathSchema = Type.String({
	minLength: 1,
	maxLength: 2048,
	pattern: "^(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)(?!.*\\u0000)[^/]+(?:/[^/]+)*$",
});
const ContentSha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const FingerprintSchema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const Base64Schema = Type.String({
	pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const DomainApiProjectRoleSchema = Type.Union([
	Type.Literal("owner"),
	Type.Literal("editor"),
	Type.Literal("viewer"),
]);

export const DomainApiArtifactIdentitySchema = Type.Object(
	{
		namespace: Type.Union([
			Type.Object({ kind: Type.Literal("target") }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("source"), sourceId: IdentifierSchema }, { additionalProperties: false }),
		]),
		kind: IdentifierSchema,
		localId: IdentifierSchema,
	},
	{ additionalProperties: false },
);

export const DomainApiRevisionArtifactSchema = Type.Object(
	{
		identity: DomainApiArtifactIdentitySchema,
		artifactVersionId: IdentifierSchema,
	},
	{ additionalProperties: false },
);

export const DomainApiRevisionSchema = Type.Object(
	{
		id: IdentifierSchema,
		parentId: Type.Union([IdentifierSchema, Type.Null()]),
		artifacts: Type.Array(DomainApiRevisionArtifactSchema),
	},
	{ additionalProperties: false },
);

export const DomainApiProjectSchema = Type.Object(
	{
		id: IdentifierSchema,
		headRevisionId: IdentifierSchema,
		role: DomainApiProjectRoleSchema,
		createdBy: IdentifierSchema,
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const DomainApiOpenStoryFileDescriptorSchema = Type.Object(
	{
		path: LogicalPathSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		contentSha256: ContentSha256Schema,
		byteLength: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const DomainApiOpenStoryFileSchema = Type.Object(
	{
		...DomainApiOpenStoryFileDescriptorSchema.properties,
		contentBase64: Base64Schema,
	},
	{ additionalProperties: false },
);

export const DomainApiOpenStoryManifestSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		contentFingerprint: FingerprintSchema,
		files: Type.Array(DomainApiOpenStoryFileDescriptorSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const DomainApiOpenStoryPackageSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		contentFingerprint: FingerprintSchema,
		files: Type.Array(DomainApiOpenStoryFileSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const DomainApiImportProjectRequestSchema = Type.Object(
	{
		projectId: IdentifierSchema,
		package: DomainApiOpenStoryPackageSchema,
	},
	{ additionalProperties: false },
);

export const DomainApiCommitRevisionRequestSchema = Type.Object(
	{
		baseRevisionId: IdentifierSchema,
		package: DomainApiOpenStoryPackageSchema,
	},
	{ additionalProperties: false },
);

export const DomainApiRevisionSnapshotSchema = Type.Object(
	{
		projectId: IdentifierSchema,
		revision: DomainApiRevisionSchema,
		manifest: DomainApiOpenStoryManifestSchema,
	},
	{ additionalProperties: false },
);

export const DomainApiHistorySchema = Type.Object(
	{
		projectId: IdentifierSchema,
		headRevisionId: IdentifierSchema,
		revisions: Type.Array(DomainApiRevisionSchema),
	},
	{ additionalProperties: false },
);

export const DomainApiArtifactVersionSchema = Type.Object(
	{
		id: IdentifierSchema,
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		contentSha256: ContentSha256Schema,
		byteLength: Type.Integer({ minimum: 0 }),
		contentBase64: Base64Schema,
	},
	{ additionalProperties: false },
);

export const DomainApiSetProjectMemberRequestSchema = Type.Object(
	{
		role: DomainApiProjectRoleSchema,
	},
	{ additionalProperties: false },
);

export const DomainApiRevisionFileStateSchema = DomainApiOpenStoryFileDescriptorSchema;

export const DomainApiRevisionDeltaSchema = Type.Object(
	{
		key: Type.String({ minLength: 1 }),
		kind: Type.Literal("story"),
		change: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
		before: Type.Optional(DomainApiRevisionFileStateSchema),
		after: Type.Optional(DomainApiRevisionFileStateSchema),
	},
	{ additionalProperties: false },
);

export const DomainApiRevisionDiffSchema = Type.Object(
	{
		projectId: IdentifierSchema,
		baseRevisionId: IdentifierSchema,
		revisionId: IdentifierSchema,
		changes: Type.Array(DomainApiRevisionDeltaSchema),
	},
	{ additionalProperties: false },
);

export const DomainApiErrorSchema = Type.Object(
	{
		protocolVersion: Type.Literal(SUIMING_DOMAIN_API_VERSION),
		requestId: IdentifierSchema,
		error: Type.Object(
			{
				code: IdentifierSchema,
				message: Type.String({ minLength: 1 }),
				retryable: Type.Boolean(),
				details: Type.Optional(Type.Unknown()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export function DomainApiSuccessSchema<T extends TSchema>(data: T) {
	return Type.Object(
		{
			protocolVersion: Type.Literal(SUIMING_DOMAIN_API_VERSION),
			requestId: IdentifierSchema,
			data,
		},
		{ additionalProperties: false },
	);
}

export type DomainApiOpenStoryPackage = Static<typeof DomainApiOpenStoryPackageSchema>;
export type DomainApiError = Static<typeof DomainApiErrorSchema>;
