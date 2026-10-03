import fastifySwagger from "@fastify/swagger";
import { SUIMING_DOMAIN_API_VERSION } from "@suiming/sdk";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { DomainApiHandler } from "./domain-api-handler.js";
import { type FastifyDomainApiInstance, registerFastifyDomainApiRoutes } from "./fastify-adapter.js";

export interface SuimingApiServerOptions {
	domainApi: DomainApiHandler;
	logger?: FastifyServerOptions["logger"];
	closeResources?: () => void | Promise<void>;
}

/**
 * Real Fastify composition root. Persistent stores, authentication and model
 * providers are injected by deployment code; this boundary owns only transport
 * registration and process lifecycle.
 */
export async function createSuimingApiServer(options: SuimingApiServerOptions): Promise<FastifyInstance> {
	const server = Fastify({ ...(options.logger === undefined ? {} : { logger: options.logger }) });
	if (options.closeResources !== undefined) server.addHook("onClose", options.closeResources);
	await server.register(fastifySwagger, {
		openapi: {
			info: { title: "Suiming Cloud API", version: SUIMING_DOMAIN_API_VERSION },
			components: {
				securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
			},
		},
	});
	const routes = server as unknown as FastifyDomainApiInstance;
	registerFastifyDomainApiRoutes(routes, options.domainApi);
	return server;
}
