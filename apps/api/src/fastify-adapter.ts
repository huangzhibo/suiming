import type { DomainApiRouteName } from "@suiming/sdk";
import type { DomainApiHandler, DomainApiHandlerResponse } from "./domain-api-handler.js";
import { domainApiTransportRoutes } from "./openapi.js";

export interface FastifyDomainApiRequest {
	headers: Readonly<Record<string, string | readonly string[] | undefined>>;
	params: unknown;
	query: unknown;
	body: unknown;
}

export interface FastifyDomainApiReply {
	code(status: number): FastifyDomainApiReply;
	headers(values: Readonly<Record<string, string>>): FastifyDomainApiReply;
	send(body: unknown): unknown;
}

export interface FastifyDomainApiRouteOptions {
	method: "GET" | "POST";
	url: string;
	schema: unknown;
	handler(request: FastifyDomainApiRequest, reply: FastifyDomainApiReply): Promise<unknown>;
}

export interface FastifyDomainApiInstance {
	route(options: FastifyDomainApiRouteOptions): unknown;
}

function send(reply: FastifyDomainApiReply, response: DomainApiHandlerResponse): unknown {
	return reply.code(response.status).headers(response.headers).send(response.body);
}

/**
 * Thin Fastify-compatible registration boundary. Authentication, validation,
 * error mapping and Runtime calls remain owned by DomainApiHandler.
 */
export function registerFastifyDomainApiRoutes(fastify: FastifyDomainApiInstance, handler: DomainApiHandler): void {
	for (const descriptor of domainApiTransportRoutes()) {
		const routeName: DomainApiRouteName = descriptor.name;
		fastify.route({
			method: descriptor.method,
			url: descriptor.path,
			schema: descriptor.schema,
			handler: async (request, reply) => {
				const response = await handler.handle({
					route: routeName,
					headers: request.headers,
					...(descriptor.schema.params === undefined ? {} : { params: request.params }),
					...(descriptor.schema.querystring === undefined ? {} : { query: request.query }),
					...(descriptor.schema.body === undefined ? {} : { body: request.body }),
				});
				return send(reply, response);
			},
		});
	}
}
