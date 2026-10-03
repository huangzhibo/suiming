import {
	DOMAIN_API_ROUTES,
	DomainApiErrorSchema,
	type DomainApiHttpMethod,
	type DomainApiRouteName,
	SUIMING_DOMAIN_API_VERSION,
} from "@suiming/sdk";
import type { TSchema } from "typebox";

export interface DomainApiTransportRoute {
	name: DomainApiRouteName;
	method: DomainApiHttpMethod;
	path: string;
	successStatus: 200 | 201 | 202;
	idempotency: "required" | "forbidden";
	schema: {
		operationId: string;
		params?: TSchema;
		querystring?: TSchema;
		body?: TSchema;
		response: Record<number | "default", TSchema>;
	};
}

interface ObjectSchema extends TSchema {
	properties?: Record<string, TSchema>;
	required?: string[];
}

function routeRequest(route: DomainApiRouteName): { params?: TSchema; query?: TSchema; body?: TSchema } {
	return DOMAIN_API_ROUTES[route].request as { params?: TSchema; query?: TSchema; body?: TSchema };
}

export function domainApiTransportRoutes(): DomainApiTransportRoute[] {
	return (Object.keys(DOMAIN_API_ROUTES) as DomainApiRouteName[]).map((name) => {
		const route = DOMAIN_API_ROUTES[name];
		const request = routeRequest(name);
		return {
			name,
			method: route.method,
			path: route.path,
			successStatus: route.successStatus,
			idempotency: route.idempotency,
			schema: {
				operationId: route.operationId,
				...(request.params === undefined ? {} : { params: request.params }),
				...(request.query === undefined ? {} : { querystring: request.query }),
				...(request.body === undefined ? {} : { body: request.body }),
				response: { [route.successStatus]: route.response, default: DomainApiErrorSchema },
			},
		};
	});
}

function openApiPath(path: string): string {
	return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
}

function parameters(schema: TSchema | undefined, location: "path" | "query"): unknown[] {
	const object = schema as ObjectSchema | undefined;
	if (object?.properties === undefined) return [];
	const required = new Set(object.required ?? []);
	return Object.entries(object.properties).map(([name, property]) => ({
		name,
		in: location,
		required: location === "path" || required.has(name),
		schema: property,
	}));
}

/** Deterministic OpenAPI projection; the future Fastify plugin consumes the same transport routes. */
export function createDomainApiOpenApiDocument(): Record<string, unknown> {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const descriptor of domainApiTransportRoutes()) {
		const route = DOMAIN_API_ROUTES[descriptor.name];
		const request = routeRequest(descriptor.name);
		const path = openApiPath(descriptor.path);
		if (paths[path] === undefined) paths[path] = {};
		const pathItem = paths[path] as Record<string, unknown>;
		pathItem[descriptor.method.toLowerCase()] = {
			operationId: descriptor.schema.operationId,
			tags: ["Suiming Domain API"],
			security: [{ bearerAuth: [] }],
			parameters: [
				...parameters(request.params, "path"),
				...parameters(request.query, "query"),
				...(descriptor.idempotency === "required"
					? [
							{
								name: "Idempotency-Key",
								in: "header",
								required: true,
								schema: { type: "string", minLength: 1 },
							},
						]
					: []),
			],
			...(request.body === undefined
				? {}
				: {
						requestBody: {
							required: true,
							content: { "application/json": { schema: request.body } },
						},
					}),
			responses: {
				[route.successStatus]: {
					description: "Successful response",
					content: { "application/json": { schema: route.response } },
				},
				default: {
					description: "Error response",
					content: { "application/json": { schema: DomainApiErrorSchema } },
				},
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Suiming Cloud Domain API",
			version: SUIMING_DOMAIN_API_VERSION,
		},
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer" },
			},
		},
		paths,
	};
}
