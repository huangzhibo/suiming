import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { DomainApiOpenStoryFileContent } from "./open-story-package-codec.js";
import {
	decodeDomainApiContent,
	decodeDomainApiOpenStoryPackage,
	encodeDomainApiOpenStoryPackage,
} from "./open-story-package-codec.js";
import { DOMAIN_API_ROUTES } from "./routes.js";
import { DomainApiErrorSchema } from "./schema.js";

export type DomainApiAccessTokenProvider = () => string | Promise<string>;

export interface DomainApiClientOptions {
	endpoint: string;
	getAccessToken: DomainApiAccessTokenProvider;
	fetch?: typeof globalThis.fetch;
}

export interface ImportDomainApiProjectInput {
	projectId: string;
	idempotencyKey: string;
	files: readonly DomainApiOpenStoryFileContent[];
}

export interface CommitDomainApiRevisionInput extends ImportDomainApiProjectInput {
	baseRevisionId: string;
}

export interface SetDomainApiProjectMemberInput {
	projectId: string;
	memberActorId: string;
	role: "owner" | "editor" | "viewer";
	idempotencyKey: string;
}

export class DomainApiClientError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly status: number | undefined;
	readonly requestId: string | undefined;
	readonly details: unknown;

	constructor(
		code: string,
		message: string,
		options: { retryable: boolean; status?: number; requestId?: string; details?: unknown; cause?: unknown },
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "DomainApiClientError";
		this.code = code;
		this.retryable = options.retryable;
		this.status = options.status;
		this.requestId = options.requestId;
		this.details = options.details;
	}
}

function nonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.includes("\0")) {
		throw new DomainApiClientError("invalid_domain_api_input", `${label} must be non-empty`, {
			retryable: false,
		});
	}
	return normalized;
}

function endpointUrl(value: string): string {
	let endpoint: URL;
	try {
		endpoint = new URL(nonempty(value, "endpoint"));
	} catch (error) {
		if (error instanceof DomainApiClientError) throw error;
		throw new DomainApiClientError("invalid_domain_api_endpoint", "endpoint must be an absolute HTTP(S) URL", {
			retryable: false,
			cause: error,
		});
	}
	if (
		(endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
		endpoint.username.length > 0 ||
		endpoint.password.length > 0 ||
		endpoint.search.length > 0 ||
		endpoint.hash.length > 0
	) {
		throw new DomainApiClientError(
			"invalid_domain_api_endpoint",
			"endpoint must use HTTP(S) and cannot contain credentials, query parameters, or fragments",
			{ retryable: false },
		);
	}
	endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
	return endpoint.toString().replace(/\/$/u, "");
}

function segment(value: string, label: string): string {
	return encodeURIComponent(nonempty(value, label));
}

export class DomainApiClient {
	readonly #endpoint: string;
	readonly #getAccessToken: DomainApiAccessTokenProvider;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: DomainApiClientOptions) {
		this.#endpoint = endpointUrl(options.endpoint);
		this.#getAccessToken = options.getAccessToken;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async importProject(input: ImportDomainApiProjectInput) {
		const body = {
			projectId: nonempty(input.projectId, "projectId"),
			package: await encodeDomainApiOpenStoryPackage(input.files),
		};
		const response = await this.#request(DOMAIN_API_ROUTES.importProject.response, "/v1/projects", {
			method: "POST",
			idempotencyKey: input.idempotencyKey,
			body,
		});
		return response.data;
	}

	async readProject(projectId: string) {
		const response = await this.#request(
			DOMAIN_API_ROUTES.readProject.response,
			`/v1/projects/${segment(projectId, "projectId")}`,
		);
		return response.data;
	}

	async setProjectMember(input: SetDomainApiProjectMemberInput) {
		const projectId = segment(input.projectId, "projectId");
		const memberActorId = segment(input.memberActorId, "memberActorId");
		const response = await this.#request(
			DOMAIN_API_ROUTES.setProjectMember.response,
			`/v1/projects/${projectId}/members/${memberActorId}`,
			{
				method: "POST",
				idempotencyKey: input.idempotencyKey,
				body: { role: input.role },
			},
		);
		return response.data.role;
	}

	async history(projectId: string) {
		const response = await this.#request(
			DOMAIN_API_ROUTES.history.response,
			`/v1/projects/${segment(projectId, "projectId")}/revisions`,
		);
		return response.data;
	}

	async commitRevision(input: CommitDomainApiRevisionInput) {
		const projectId = segment(input.projectId, "projectId");
		const response = await this.#request(
			DOMAIN_API_ROUTES.commitRevision.response,
			`/v1/projects/${projectId}/revisions`,
			{
				method: "POST",
				idempotencyKey: input.idempotencyKey,
				body: {
					baseRevisionId: nonempty(input.baseRevisionId, "baseRevisionId"),
					package: await encodeDomainApiOpenStoryPackage(input.files),
				},
			},
		);
		return response.data;
	}

	async readRevision(projectIdValue: string, revisionIdValue: string) {
		const projectId = segment(projectIdValue, "projectId");
		const revisionId = segment(revisionIdValue, "revisionId");
		const response = await this.#request(
			DOMAIN_API_ROUTES.readRevision.response,
			`/v1/projects/${projectId}/revisions/${revisionId}`,
		);
		return response.data;
	}

	async readArtifactVersion(projectIdValue: string, artifactVersionIdValue: string) {
		const projectId = segment(projectIdValue, "projectId");
		const artifactVersionId = segment(artifactVersionIdValue, "artifactVersionId");
		const response = await this.#request(
			DOMAIN_API_ROUTES.readArtifactVersion.response,
			`/v1/projects/${projectId}/artifact-versions/${artifactVersionId}`,
		);
		return {
			id: response.data.id,
			mediaType: response.data.mediaType,
			bytes: await decodeDomainApiContent(response.data),
		};
	}

	async exportRevision(projectIdValue: string, revisionIdValue: string): Promise<DomainApiOpenStoryFileContent[]> {
		const projectId = segment(projectIdValue, "projectId");
		const revisionId = segment(revisionIdValue, "revisionId");
		const response = await this.#request(
			DOMAIN_API_ROUTES.exportRevision.response,
			`/v1/projects/${projectId}/revisions/${revisionId}/package`,
		);
		return decodeDomainApiOpenStoryPackage(response.data);
	}

	async diffRevision(projectIdValue: string, baseRevisionIdValue: string, revisionIdValue: string) {
		const projectId = segment(projectIdValue, "projectId");
		const baseRevisionId = segment(baseRevisionIdValue, "baseRevisionId");
		const revisionId = segment(revisionIdValue, "revisionId");
		const response = await this.#request(
			DOMAIN_API_ROUTES.diffRevision.response,
			`/v1/projects/${projectId}/revisions/${revisionId}/diff?baseRevisionId=${baseRevisionId}`,
		);
		return response.data;
	}

	async #request<T extends TSchema>(
		schema: T,
		path: string,
		options: { method?: "GET" | "POST"; idempotencyKey?: string; body?: unknown } = {},
	): Promise<Static<T>> {
		const token = nonempty(await this.#getAccessToken(), "access token");
		const headers: Record<string, string> = {
			accept: "application/json",
			authorization: `Bearer ${token}`,
		};
		if (options.body !== undefined) headers["content-type"] = "application/json";
		if (options.idempotencyKey !== undefined) {
			headers["idempotency-key"] = nonempty(options.idempotencyKey, "idempotencyKey");
		}
		let response: Response;
		try {
			response = await this.#fetch(`${this.#endpoint}${path}`, {
				method: options.method ?? "GET",
				headers,
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
			});
		} catch (error) {
			throw new DomainApiClientError("domain_api_transport_error", "Cloud Domain API request failed", {
				retryable: true,
				cause: error,
			});
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			throw new DomainApiClientError("invalid_domain_api_response", "Cloud Domain API returned invalid JSON", {
				retryable: response.status >= 500,
				status: response.status,
				cause: error,
			});
		}
		if (!response.ok) {
			if (Value.Check(DomainApiErrorSchema, body)) {
				throw new DomainApiClientError(body.error.code, body.error.message, {
					retryable: body.error.retryable,
					status: response.status,
					requestId: body.requestId,
					...(body.error.details === undefined ? {} : { details: body.error.details }),
				});
			}
			throw new DomainApiClientError("invalid_domain_api_error", "Cloud Domain API returned an invalid error", {
				retryable: response.status >= 500,
				status: response.status,
			});
		}
		if (!Value.Check(schema, body)) {
			throw new DomainApiClientError("invalid_domain_api_response", "Cloud Domain API response schema mismatch", {
				retryable: false,
				status: response.status,
			});
		}
		return body as Static<T>;
	}
}
