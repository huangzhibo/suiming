import { Type } from "typebox";
import {
	DomainApiArtifactVersionSchema,
	DomainApiCommitRevisionRequestSchema,
	DomainApiHistorySchema,
	DomainApiImportProjectRequestSchema,
	DomainApiOpenStoryPackageSchema,
	DomainApiProjectRoleSchema,
	DomainApiProjectSchema,
	DomainApiRevisionDiffSchema,
	DomainApiRevisionSchema,
	DomainApiRevisionSnapshotSchema,
	DomainApiSetProjectMemberRequestSchema,
	DomainApiSuccessSchema,
} from "./schema.js";

export type DomainApiHttpMethod = "GET" | "POST";
export type DomainApiCapability = "project.create" | "project.read" | "project.write" | "project.manage";

export interface DomainApiRouteDefinition {
	operationId: string;
	method: DomainApiHttpMethod;
	path: string;
	successStatus: 200 | 201 | 202;
	capability: DomainApiCapability;
	idempotency: "required" | "forbidden";
	request: {
		params?: unknown;
		query?: unknown;
		body?: unknown;
	};
	response: unknown;
}

const ProjectParamsSchema = Type.Object({ projectId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const RevisionParamsSchema = Type.Object(
	{ projectId: Type.String({ minLength: 1 }), revisionId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const ArtifactVersionParamsSchema = Type.Object(
	{ projectId: Type.String({ minLength: 1 }), artifactVersionId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);
const ProjectMemberParamsSchema = Type.Object(
	{ projectId: Type.String({ minLength: 1 }), memberActorId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

/**
 * Cloud transport catalog. Fastify, generated OpenAPI and the SDK client must all
 * consume this catalog instead of maintaining parallel route names.
 */
export const DOMAIN_API_ROUTES = {
	importProject: {
		operationId: "project.import",
		method: "POST",
		path: "/v1/projects",
		successStatus: 201,
		capability: "project.create",
		idempotency: "required",
		request: { body: DomainApiImportProjectRequestSchema },
		response: DomainApiSuccessSchema(
			Type.Object(
				{ project: DomainApiProjectSchema, revision: DomainApiRevisionSchema },
				{ additionalProperties: false },
			),
		),
	},
	readProject: {
		operationId: "project.read",
		method: "GET",
		path: "/v1/projects/:projectId",
		successStatus: 200,
		capability: "project.read",
		idempotency: "forbidden",
		request: { params: ProjectParamsSchema },
		response: DomainApiSuccessSchema(DomainApiProjectSchema),
	},
	setProjectMember: {
		operationId: "project.member.set",
		method: "POST",
		path: "/v1/projects/:projectId/members/:memberActorId",
		successStatus: 200,
		capability: "project.manage",
		idempotency: "required",
		request: { params: ProjectMemberParamsSchema, body: DomainApiSetProjectMemberRequestSchema },
		response: DomainApiSuccessSchema(
			Type.Object({ role: DomainApiProjectRoleSchema }, { additionalProperties: false }),
		),
	},
	history: {
		operationId: "revision.history",
		method: "GET",
		path: "/v1/projects/:projectId/revisions",
		successStatus: 200,
		capability: "project.read",
		idempotency: "forbidden",
		request: { params: ProjectParamsSchema },
		response: DomainApiSuccessSchema(DomainApiHistorySchema),
	},
	commitRevision: {
		operationId: "revision.commit",
		method: "POST",
		path: "/v1/projects/:projectId/revisions",
		successStatus: 201,
		capability: "project.write",
		idempotency: "required",
		request: { params: ProjectParamsSchema, body: DomainApiCommitRevisionRequestSchema },
		response: DomainApiSuccessSchema(DomainApiRevisionSnapshotSchema),
	},
	readRevision: {
		operationId: "revision.read",
		method: "GET",
		path: "/v1/projects/:projectId/revisions/:revisionId",
		successStatus: 200,
		capability: "project.read",
		idempotency: "forbidden",
		request: { params: RevisionParamsSchema },
		response: DomainApiSuccessSchema(DomainApiRevisionSnapshotSchema),
	},
	readArtifactVersion: {
		operationId: "artifact-version.read",
		method: "GET",
		path: "/v1/projects/:projectId/artifact-versions/:artifactVersionId",
		successStatus: 200,
		capability: "project.read",
		idempotency: "forbidden",
		request: { params: ArtifactVersionParamsSchema },
		response: DomainApiSuccessSchema(DomainApiArtifactVersionSchema),
	},
	exportRevision: {
		operationId: "revision.export",
		method: "GET",
		path: "/v1/projects/:projectId/revisions/:revisionId/package",
		successStatus: 200,
		capability: "project.read",
		idempotency: "forbidden",
		request: { params: RevisionParamsSchema },
		response: DomainApiSuccessSchema(DomainApiOpenStoryPackageSchema),
	},
	diffRevision: {
		operationId: "revision.diff",
		method: "GET",
		path: "/v1/projects/:projectId/revisions/:revisionId/diff",
		successStatus: 200,
		capability: "project.read",
		idempotency: "forbidden",
		request: {
			params: RevisionParamsSchema,
			query: Type.Object({ baseRevisionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		},
		response: DomainApiSuccessSchema(DomainApiRevisionDiffSchema),
	},
} as const satisfies Record<string, DomainApiRouteDefinition>;

export type DomainApiRouteName = keyof typeof DOMAIN_API_ROUTES;
