import {
	DOMAIN_API_ROUTES,
	DomainApiErrorSchema,
	type DomainApiHttpMethod,
	type DomainApiRouteName,
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

function routeRequest(route: DomainApiRouteName): { params?: TSchema; query?: TSchema; body?: TSchema } {
	return DOMAIN_API_ROUTES[route].request as { params?: TSchema; query?: TSchema; body?: TSchema };
}

/** SDK 路由目录投影成 Fastify 路由：schema 交给 Fastify 校验，也是 @fastify/swagger 生成 OpenAPI 的唯一来源。 */
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
