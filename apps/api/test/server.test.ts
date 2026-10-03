import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudProjectService, InMemoryCloudProjectStore } from "@suiming/runtime";
import { encodeDomainApiOpenStoryPackage } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";
import {
	createBearerTokenAuthenticator,
	createDurableSuimingApiServer,
	createSuimingApiServer,
	DomainApiHandler,
} from "../src/index.js";

const durablePostgresUrl = process.env.SUIMING_TEST_POSTGRES_URL;
const durableS3Endpoint = process.env.SUIMING_TEST_S3_ENDPOINT;
const durableS3AccessKey = process.env.SUIMING_TEST_S3_ACCESS_KEY;
const durableS3SecretKey = process.env.SUIMING_TEST_S3_SECRET_KEY;
const durableIntegrationEnabled =
	process.env.SUIMING_TEST_DURABLE_DEPLOYMENT === "1" &&
	durablePostgresUrl !== undefined &&
	durableS3Endpoint !== undefined &&
	durableS3AccessKey !== undefined &&
	durableS3SecretKey !== undefined;

test("real Fastify composition registers OpenAPI and the Domain API, and closes resources", async () => {
	const projects = new InMemoryCloudProjectStore();
	const authenticate = createBearerTokenAuthenticator(() => undefined);
	let resourcesClosed = false;
	const server = await createSuimingApiServer({
		domainApi: new DomainApiHandler({ projects: new CloudProjectService(projects), authenticate }),
		closeResources: () => {
			resourcesClosed = true;
		},
	});

	await server.ready();
	const response = await server.inject({
		method: "GET",
		url: "/v1/projects/project-1",
	});
	assert.equal(response.statusCode, 401);
	assert.equal(response.json().error.code, "cloud_authentication_required");

	const document = server.swagger() as { paths: Record<string, Record<string, { operationId?: string }>> };
	assert.equal(document.paths["/v1/projects/{projectId}"]?.get?.operationId, "project.read");
	assert.equal(document.paths["/v1/projects/{projectId}/agent"], undefined);
	// Cloud 只剩 Canon 与同步：没有执行、没有事件流。
	assert.equal(document.paths["/v1/projects/{projectId}/runs/{runId}/events"], undefined);
	assert.equal(document.paths["/v1/projects/{projectId}/runs/{runId}"], undefined);

	await server.close();
	assert.equal(resourcesClosed, true);
});

test("durable API composition migrates PostgreSQL and round-trips an S3-backed Project across restart", {
	skip: durableIntegrationEnabled
		? false
		: "set SUIMING_TEST_DURABLE_DEPLOYMENT=1 with PostgreSQL and S3 integration variables",
}, async () => {
	const bucket = process.env.SUIMING_TEST_S3_BUCKET ?? "suiming-integration-test";
	const region = process.env.SUIMING_TEST_S3_REGION ?? "us-east-1";
	const bootstrap = new S3Client({
		endpoint: durableS3Endpoint as string,
		region,
		forcePathStyle: true,
		credentials: {
			accessKeyId: durableS3AccessKey as string,
			secretAccessKey: durableS3SecretKey as string,
		},
	});
	try {
		await bootstrap.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		if (name !== "BucketAlreadyExists" && name !== "BucketAlreadyOwnedByYou") throw error;
	} finally {
		bootstrap.destroy();
	}

	const projectId = `project-durable-${randomUUID()}`;
	const keyPrefix = `durable/${randomUUID()}`;
	const authenticate = createBearerTokenAuthenticator((token) =>
		token === "durable-owner-token" ? { actorId: "durable-owner" } : undefined,
	);
	const deployment = {
		postgres: {
			connectionString: durablePostgresUrl as string,
			applicationName: "suiming-api-durable-test",
		},
		s3: {
			endpoint: durableS3Endpoint as string,
			region,
			forcePathStyle: true,
			bucket,
			keyPrefix,
			credentials: {
				accessKeyId: durableS3AccessKey as string,
				secretAccessKey: durableS3SecretKey as string,
			},
		},
		authenticate,
		inlineTextThresholdBytes: 0,
	};
	const packageData = await encodeDomainApiOpenStoryPackage(sampleWorkFiles());

	const first = await createDurableSuimingApiServer(deployment);
	await first.ready();
	const imported = await first.inject({
		method: "POST",
		url: "/v1/projects",
		headers: {
			authorization: "Bearer durable-owner-token",
			"idempotency-key": "durable-import",
		},
		payload: { projectId, package: packageData },
	});
	assert.equal(imported.statusCode, 201, imported.body);
	const revisionId = imported.json().data.revision.id as string;
	await first.close();

	const restarted = await createDurableSuimingApiServer(deployment);
	try {
		await restarted.ready();
		const project = await restarted.inject({
			method: "GET",
			url: `/v1/projects/${projectId}`,
			headers: { authorization: "Bearer durable-owner-token" },
		});
		assert.equal(project.statusCode, 200, project.body);
		assert.equal(project.json().data.headRevisionId, revisionId);
		const exported = await restarted.inject({
			method: "GET",
			url: `/v1/projects/${projectId}/revisions/${revisionId}/package`,
			headers: { authorization: "Bearer durable-owner-token" },
		});
		assert.equal(exported.statusCode, 200, exported.body);
		assert.deepEqual(exported.json().data, packageData);
	} finally {
		await restarted.close();
	}
});
