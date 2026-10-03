import { randomUUID } from "node:crypto";
import type { CloudProjectRole, CloudProjectService, CloudRevisionView } from "@suiming/runtime";
import {
	DOMAIN_API_ROUTES,
	type DomainApiError,
	type DomainApiRouteName,
	decodeDomainApiOpenStoryPackage,
	encodeDomainApiContent,
	encodeDomainApiOpenStoryPackage,
	SUIMING_DOMAIN_API_VERSION,
} from "@suiming/sdk";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export interface DomainApiPrincipal {
	actorId: string;
}

export interface AuthenticateDomainApiRequestInput {
	authorization: string | undefined;
	requestId: string;
}

export type DomainApiAuthenticator = (
	input: AuthenticateDomainApiRequestInput,
) => DomainApiPrincipal | Promise<DomainApiPrincipal>;

export type DomainApiBearerTokenResolver = (
	token: string,
) => DomainApiPrincipal | undefined | Promise<DomainApiPrincipal | undefined>;

export class DomainApiAuthenticationError extends Error {
	readonly code: string;
	readonly retryable = false;
	readonly status = 401;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DomainApiAuthenticationError";
		this.code = code;
	}
}

export function createBearerTokenAuthenticator(resolveToken: DomainApiBearerTokenResolver): DomainApiAuthenticator {
	return async ({ authorization }) => {
		const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
		if (match === null) {
			throw new DomainApiAuthenticationError(
				"cloud_authentication_required",
				"A valid Bearer access token is required",
			);
		}
		const principal = await resolveToken(match[1] as string);
		if (principal === undefined || principal.actorId.trim().length === 0 || principal.actorId.includes("\0")) {
			throw new DomainApiAuthenticationError("cloud_authentication_failed", "Bearer access token is invalid");
		}
		return { actorId: principal.actorId.trim() };
	};
}

export interface DomainApiHandlerRequest {
	route: DomainApiRouteName;
	headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
	params?: unknown;
	query?: unknown;
	body?: unknown;
}

export interface DomainApiHandlerResponse {
	status: number;
	headers: Readonly<Record<string, string>>;
	body: unknown;
}

export interface DomainApiHandlerOptions {
	projects: CloudProjectService;
	authenticate: DomainApiAuthenticator;
	requestId?: () => string;
}

interface ProjectParams {
	projectId: string;
}

interface RevisionParams extends ProjectParams {
	revisionId: string;
}

interface ArtifactVersionParams extends ProjectParams {
	artifactVersionId: string;
}

interface ProjectMemberParams extends ProjectParams {
	memberActorId: string;
}

interface ImportProjectBody {
	projectId: string;
	package: unknown;
}

interface CommitRevisionBody {
	baseRevisionId: string;
	package: unknown;
}

interface ProjectMemberBody {
	role: CloudProjectRole;
}

interface RevisionDiffQuery {
	baseRevisionId: string;
}

class DomainApiRequestError extends Error {
	readonly code: string;
	readonly status: number;
	readonly retryable = false;
	readonly details: unknown;

	constructor(code: string, message: string, status: number, details?: unknown) {
		super(message);
		this.name = "DomainApiRequestError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

class DomainApiResponseContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DomainApiResponseContractError";
	}
}

function header(headers: DomainApiHandlerRequest["headers"], name: string): string | undefined {
	if (headers === undefined) return undefined;
	const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new DomainApiRequestError("invalid_domain_api_header", `Header ${name} must appear once`, 400);
	}
	const value = matches[0]?.[1];
	if (value === undefined || typeof value === "string") return value;
	if (value.length !== 1) {
		throw new DomainApiRequestError("invalid_domain_api_header", `Header ${name} must contain one value`, 400);
	}
	return value[0];
}

function idempotencyKey(request: DomainApiHandlerRequest): string | undefined {
	const route = DOMAIN_API_ROUTES[request.route];
	const value = header(request.headers, "idempotency-key")?.trim();
	if (route.idempotency === "required") {
		if (value === undefined || value.length === 0 || value.includes("\0")) {
			throw new DomainApiRequestError(
				"domain_api_idempotency_key_required",
				"Idempotency-Key is required for this operation",
				400,
			);
		}
		return value;
	}
	if (value !== undefined) {
		throw new DomainApiRequestError(
			"domain_api_idempotency_key_forbidden",
			"Idempotency-Key is only accepted by mutating operations",
			400,
		);
	}
	return undefined;
}

function requestSchemas(route: DomainApiRouteName): { params?: TSchema; query?: TSchema; body?: TSchema } {
	return DOMAIN_API_ROUTES[route].request as { params?: TSchema; query?: TSchema; body?: TSchema };
}

function validatePart(part: "params" | "query" | "body", schema: TSchema | undefined, value: unknown): void {
	if (schema === undefined) {
		if (value !== undefined) {
			throw new DomainApiRequestError("invalid_domain_api_request", `Route does not accept ${part}`, 400, { part });
		}
		return;
	}
	if (!Value.Check(schema, value)) {
		throw new DomainApiRequestError(
			"invalid_domain_api_request",
			`Request ${part} does not match the route schema`,
			400,
			{ part },
		);
	}
}

async function revisionSnapshotData(projectId: string, view: CloudRevisionView) {
	const packageData = await encodeDomainApiOpenStoryPackage(view.files);
	if (packageData.contentFingerprint !== view.contentFingerprint) {
		throw new DomainApiResponseContractError("Runtime and wire codecs disagree on the revision fingerprint");
	}
	return {
		projectId,
		revision: view.snapshot.revision,
		manifest: {
			schemaVersion: packageData.schemaVersion,
			contentFingerprint: packageData.contentFingerprint,
			files: packageData.files.map(({ contentBase64: _contentBase64, ...file }) => file),
		},
	};
}

const NOT_FOUND_CODES = new Set([
	"artifact_version_not_found",
	"cloud_project_not_found",
	"project_not_found",
	"revision_not_found",
]);
const CONFLICT_CODES = new Set([
	"cloud_idempotency_conflict",
	"cloud_last_owner",
	"cloud_no_changes",
	"project_already_exists",
	"revision_conflict",
]);
const UNPROCESSABLE_CODES = new Set([
	"design_check_failed",
	"source_check_failed",
	"source_state_check_failed",
	"story_state_check_failed",
	"story_text_check_failed",
]);

function codedError(
	error: unknown,
): (Error & { code: string; retryable?: boolean; status?: number; details?: unknown }) | undefined {
	return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
		? (error as Error & { code: string; retryable?: boolean; status?: number; details?: unknown })
		: undefined;
}

function errorResponse(requestId: string, error: unknown): DomainApiHandlerResponse {
	const coded = codedError(error);
	let status = coded?.status;
	if (status === undefined && coded !== undefined) {
		status = coded.code === "cloud_access_denied" ? 403 : undefined;
		status ??= NOT_FOUND_CODES.has(coded.code) ? 404 : undefined;
		status ??= CONFLICT_CODES.has(coded.code) ? 409 : undefined;
		status ??= UNPROCESSABLE_CODES.has(coded.code) ? 422 : undefined;
		status ??= coded.code.startsWith("invalid_") || coded.code.startsWith("content_") ? 400 : undefined;
	}
	const expose = coded !== undefined && status !== undefined && status < 500;
	const body: DomainApiError = {
		protocolVersion: SUIMING_DOMAIN_API_VERSION,
		requestId,
		error: {
			code: expose ? coded.code : "internal_error",
			message: expose ? coded.message : "Internal server error",
			retryable: expose ? (coded.retryable ?? false) : true,
			...(expose && coded.details !== undefined ? { details: coded.details } : {}),
		},
	};
	return {
		status: status ?? 500,
		headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
		body,
	};
}

export class DomainApiHandler {
	readonly #projects: CloudProjectService;
	readonly #authenticate: DomainApiAuthenticator;
	readonly #requestId: () => string;

	constructor(options: DomainApiHandlerOptions) {
		this.#projects = options.projects;
		this.#authenticate = options.authenticate;
		this.#requestId = options.requestId ?? randomUUID;
	}

	async handle(request: DomainApiHandlerRequest): Promise<DomainApiHandlerResponse> {
		const generatedRequestId = this.#requestId().trim();
		const requestId =
			generatedRequestId.length > 0 && !generatedRequestId.includes("\0") ? generatedRequestId : randomUUID();
		try {
			const route = DOMAIN_API_ROUTES[request.route];
			const schemas = requestSchemas(request.route);
			validatePart("params", schemas.params, request.params);
			validatePart("query", schemas.query, request.query);
			validatePart("body", schemas.body, request.body);
			const commandId = idempotencyKey(request);
			const principal = await this.#authenticate({
				authorization: header(request.headers, "authorization"),
				requestId,
			});
			const data = await this.#execute(request, principal.actorId, commandId);
			const body = { protocolVersion: SUIMING_DOMAIN_API_VERSION, requestId, data };
			if (!Value.Check(route.response, body)) {
				throw new DomainApiResponseContractError(`Response for ${route.operationId} does not match its schema`);
			}
			return {
				status: route.successStatus,
				headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
				body,
			};
		} catch (error) {
			return errorResponse(requestId, error);
		}
	}

	async #execute(request: DomainApiHandlerRequest, actorId: string, commandId: string | undefined): Promise<unknown> {
		switch (request.route) {
			case "importProject": {
				const body = request.body as ImportProjectBody;
				const view = await this.#projects.importSnapshot({
					projectId: body.projectId,
					actorId,
					idempotencyKey: commandId as string,
					files: await decodeDomainApiOpenStoryPackage(body.package),
				});
				const project = await this.#projects.project({ projectId: body.projectId, actorId });
				return { project: { ...project.project, role: project.role }, revision: view.snapshot.revision };
			}
			case "readProject": {
				const { projectId } = request.params as ProjectParams;
				const view = await this.#projects.project({ projectId, actorId });
				return { ...view.project, role: view.role };
			}
			case "setProjectMember": {
				const { projectId, memberActorId } = request.params as ProjectMemberParams;
				const { role } = request.body as ProjectMemberBody;
				return {
					role: await this.#projects.setMember({
						projectId,
						actorId,
						idempotencyKey: commandId as string,
						memberActorId,
						role,
					}),
				};
			}
			case "history": {
				const { projectId } = request.params as ProjectParams;
				const [project, revisions] = await Promise.all([
					this.#projects.project({ projectId, actorId }),
					this.#projects.history({ projectId, actorId }),
				]);
				return { projectId, headRevisionId: project.project.headRevisionId, revisions };
			}
			case "commitRevision": {
				const { projectId } = request.params as ProjectParams;
				const body = request.body as CommitRevisionBody;
				return revisionSnapshotData(
					projectId,
					await this.#projects.commitSnapshot({
						projectId,
						actorId,
						idempotencyKey: commandId as string,
						baseRevisionId: body.baseRevisionId,
						files: await decodeDomainApiOpenStoryPackage(body.package),
					}),
				);
			}
			case "readRevision": {
				const { projectId, revisionId } = request.params as RevisionParams;
				return revisionSnapshotData(projectId, await this.#projects.revision({ projectId, actorId, revisionId }));
			}
			case "readArtifactVersion": {
				const { projectId, artifactVersionId } = request.params as ArtifactVersionParams;
				const version = await this.#projects.readVersion({ projectId, actorId, artifactVersionId });
				return {
					id: version.id,
					mediaType: version.mediaType,
					...(await encodeDomainApiContent(version.bytes)),
				};
			}
			case "exportRevision": {
				const { projectId, revisionId } = request.params as RevisionParams;
				const view = await this.#projects.revision({ projectId, actorId, revisionId });
				return encodeDomainApiOpenStoryPackage(view.files);
			}
			case "diffRevision": {
				const { projectId, revisionId } = request.params as RevisionParams;
				const { baseRevisionId } = request.query as RevisionDiffQuery;
				return this.#projects.diff({ projectId, actorId, baseRevisionId, revisionId });
			}
		}
	}
}
