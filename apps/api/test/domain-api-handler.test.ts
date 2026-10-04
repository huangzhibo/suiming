import assert from "node:assert/strict";
import test from "node:test";
import { CloudProjectService } from "@suiming/runtime";
import {
	DOMAIN_API_ROUTES,
	DomainApiErrorSchema,
	encodeDomainApiOpenStoryPackage,
	SUIMING_DOMAIN_API_VERSION,
} from "@suiming/sdk";
import { Value } from "typebox/value";
import { InMemoryCloudProjectStore } from "../../../packages/runtime/test/in-memory-cloud.js";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import {
	createBearerTokenAuthenticator,
	createDomainApiOpenApiDocument,
	DomainApiHandler,
	domainApiTransportRoutes,
	type FastifyDomainApiRouteOptions,
	registerFastifyDomainApiRoutes,
} from "../src/index.js";

const ownerId = "author-1";
const projectId = "project-1";

async function fixturePackage() {
	return encodeDomainApiOpenStoryPackage(sampleWorkFiles());
}

function setup() {
	const projects = new InMemoryCloudProjectStore();
	let requestOrdinal = 0;
	const handler = new DomainApiHandler({
		projects: new CloudProjectService(projects),
		authenticate: createBearerTokenAuthenticator(async (token) => {
			if (token === "owner-token") return { actorId: ownerId };
			if (token === "viewer-token") return { actorId: "reader-1" };
			return undefined;
		}),
		requestId: () => `request-${String(++requestOrdinal)}`,
	});
	return { projects, handler };
}

function auth(token = "owner-token") {
	return { authorization: `Bearer ${token}` };
}

test("DomainApiHandler authenticates, validates and delegates Project routes to Runtime services", async () => {
	const { handler } = setup();
	const packageData = await fixturePackage();
	const imported = await handler.handle({
		route: "importProject",
		headers: { ...auth(), "idempotency-key": "project:import" },
		body: { projectId, package: packageData },
	});
	assert.equal(imported.status, 201);
	assert.equal(Value.Check(DOMAIN_API_ROUTES.importProject.response, imported.body), true);
	const importData = (
		imported.body as { data: { revision: { id: string; artifacts: { artifactVersionId: string }[] } } }
	).data;
	const genesisRevisionId = importData.revision.id;

	const unauthenticated = await handler.handle({
		route: "readProject",
		headers: {},
		params: { projectId },
	});
	assert.equal(unauthenticated.status, 401);
	assert.equal(Value.Check(DomainApiErrorSchema, unauthenticated.body), true);
	assert.equal((unauthenticated.body as { error: { code: string } }).error.code, "cloud_authentication_required");

	const forbiddenHeader = await handler.handle({
		route: "readProject",
		headers: { ...auth(), "idempotency-key": "not-allowed" },
		params: { projectId },
	});
	assert.equal(forbiddenHeader.status, 400);
	assert.equal(
		(forbiddenHeader.body as { error: { code: string } }).error.code,
		"domain_api_idempotency_key_forbidden",
	);

	const member = await handler.handle({
		route: "setProjectMember",
		headers: { ...auth(), "idempotency-key": "member:set" },
		params: { projectId, memberActorId: "reader-1" },
		body: { role: "viewer" },
	});
	assert.equal(member.status, 200);
	assert.equal(Value.Check(DOMAIN_API_ROUTES.setProjectMember.response, member.body), true);

	const viewed = await handler.handle({
		route: "readProject",
		headers: auth("viewer-token"),
		params: { projectId },
	});
	assert.equal(viewed.status, 200);
	assert.equal((viewed.body as { data: { role: string } }).data.role, "viewer");

	const deniedMemberWrite = await handler.handle({
		route: "setProjectMember",
		headers: { ...auth("viewer-token"), "idempotency-key": "member:denied" },
		params: { projectId, memberActorId: "other-reader" },
		body: { role: "viewer" },
	});
	assert.equal(deniedMemberWrite.status, 403);
	assert.equal((deniedMemberWrite.body as { error: { code: string } }).error.code, "cloud_access_denied");

	const revision = await handler.handle({
		route: "readRevision",
		headers: auth("viewer-token"),
		params: { projectId, revisionId: genesisRevisionId },
	});
	assert.equal(revision.status, 200);
	assert.equal(Value.Check(DOMAIN_API_ROUTES.readRevision.response, revision.body), true);

	const artifactVersion = await handler.handle({
		route: "readArtifactVersion",
		headers: auth("viewer-token"),
		params: { projectId, artifactVersionId: importData.revision.artifacts[0]?.artifactVersionId },
	});
	assert.equal(artifactVersion.status, 200);
	assert.equal(Value.Check(DOMAIN_API_ROUTES.readArtifactVersion.response, artifactVersion.body), true);

	const exported = await handler.handle({
		route: "exportRevision",
		headers: auth("viewer-token"),
		params: { projectId, revisionId: genesisRevisionId },
	});
	assert.equal(exported.status, 200);
	assert.deepEqual((exported.body as { data: unknown }).data, packageData);

	const nextPackage = structuredClone(packageData);
	const intent = nextPackage.files.find((file) => file.path === "intent/计谋的代价.md");
	assert.ok(intent);
	const nextBytes = new TextEncoder().encode(
		`${Buffer.from(intent.contentBase64, "base64").toString("utf8")}\n新增代价。\n`,
	);
	const replacement = await encodeDomainApiOpenStoryPackage([
		...nextPackage.files
			.filter((file) => file.path !== intent.path)
			.map((file) => ({
				path: file.path,
				mediaType: file.mediaType,
				bytes: new Uint8Array(Buffer.from(file.contentBase64, "base64")),
			})),
		{ path: intent.path, mediaType: intent.mediaType, bytes: nextBytes },
	]);
	const committed = await handler.handle({
		route: "commitRevision",
		headers: { ...auth(), "idempotency-key": "revision:commit" },
		params: { projectId },
		body: { baseRevisionId: genesisRevisionId, package: replacement },
	});
	assert.equal(committed.status, 201);
	assert.equal(Value.Check(DOMAIN_API_ROUTES.commitRevision.response, committed.body), true);
	const committedRevisionId = (committed.body as { data: { revision: { id: string } } }).data.revision.id;

	const diff = await handler.handle({
		route: "diffRevision",
		headers: auth("viewer-token"),
		params: { projectId, revisionId: committedRevisionId },
		query: { baseRevisionId: genesisRevisionId },
	});
	assert.equal(diff.status, 200);
	assert.equal((diff.body as { data: { changes: unknown[] } }).data.changes.length, 1);

	const tampered = structuredClone(replacement);
	const tamperedFile = tampered.files[0];
	assert.ok(tamperedFile);
	tampered.files[0] = { ...tamperedFile, contentBase64: Buffer.from("tampered").toString("base64") };
	const rejected = await handler.handle({
		route: "commitRevision",
		headers: { ...auth(), "idempotency-key": "revision:tampered" },
		params: { projectId },
		body: { baseRevisionId: committedRevisionId, package: tampered },
	});
	assert.equal(rejected.status, 400);
	assert.equal((rejected.body as { error: { code: string } }).error.code, "content_length_mismatch");
});

test("transport route and OpenAPI projections preserve the SDK route catalog exactly", () => {
	const descriptors = domainApiTransportRoutes();
	assert.equal(descriptors.length, Object.keys(DOMAIN_API_ROUTES).length);
	for (const descriptor of descriptors) {
		const source = DOMAIN_API_ROUTES[descriptor.name];
		assert.equal(descriptor.method, source.method);
		assert.equal(descriptor.path, source.path);
		assert.equal(descriptor.successStatus, source.successStatus);
		assert.equal(descriptor.schema.operationId, source.operationId);
		assert.equal(descriptor.schema.response[source.successStatus], source.response);
	}

	const document = createDomainApiOpenApiDocument() as {
		openapi: string;
		info: { version: string };
		paths: Record<string, Record<string, { operationId: string; parameters: Array<{ name: string }> }>>;
	};
	assert.equal(document.openapi, "3.1.0");
	assert.equal(document.info.version, SUIMING_DOMAIN_API_VERSION);
	for (const source of Object.values(DOMAIN_API_ROUTES)) {
		const path = source.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
		const operation = document.paths[path]?.[source.method.toLowerCase()];
		assert.equal(operation?.operationId, source.operationId);
		assert.equal(
			operation?.parameters.some((parameter) => parameter.name === "Idempotency-Key"),
			source.idempotency === "required",
		);
	}
});

test("Fastify adapter registers every catalog route and forwards framework request/reply without domain logic", async () => {
	const { handler } = setup();
	const registered: FastifyDomainApiRouteOptions[] = [];
	registerFastifyDomainApiRoutes(
		{
			route: (options) => registered.push(options),
		},
		handler,
	);
	assert.equal(registered.length, Object.keys(DOMAIN_API_ROUTES).length);
	const readProject = registered.find((route) => route.url === "/v1/projects/:projectId" && route.method === "GET");
	assert.ok(readProject);
	let status = 0;
	let responseHeaders: Readonly<Record<string, string>> = {};
	let body: unknown;
	const reply = {
		code(value: number) {
			status = value;
			return this;
		},
		headers(value: Readonly<Record<string, string>>) {
			responseHeaders = value;
			return this;
		},
		send(value: unknown) {
			body = value;
			return value;
		},
	};
	await readProject.handler({ headers: {}, params: { projectId }, query: {}, body: undefined }, reply);
	assert.equal(status, 401);
	assert.equal(responseHeaders["content-type"], "application/json; charset=utf-8");
	assert.equal(Value.Check(DomainApiErrorSchema, body), true);
});
