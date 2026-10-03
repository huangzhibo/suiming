import assert from "node:assert/strict";
import test from "node:test";
import { DomainApiClient, DomainApiClientError, SUIMING_DOMAIN_API_VERSION } from "../src/index.js";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

test("DomainApiClient injects auth and idempotency without exposing them in package data", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const client = new DomainApiClient({
		endpoint: "https://cloud.example.test/api/",
		getAccessToken: () => "secret-token",
		fetch: async (input, init) => {
			request = { url: String(input), ...(init === undefined ? {} : { init }) };
			return jsonResponse({
				protocolVersion: SUIMING_DOMAIN_API_VERSION,
				requestId: "request-1",
				data: {
					project: {
						id: "project-1",
						headRevisionId: "revision-1",
						role: "owner",
						createdBy: "actor-1",
						createdAt: "2026-09-03T00:00:00.000Z",
						updatedAt: "2026-09-03T00:00:00.000Z",
					},
					revision: { id: "revision-1", parentId: null, artifacts: [] },
				},
			});
		},
	});
	const result = await client.importProject({
		projectId: "project-1",
		idempotencyKey: "command-1",
		files: [{ path: "intent/a.md", mediaType: "text/markdown", bytes: new TextEncoder().encode("hello") }],
	});
	assert.equal(result.project.id, "project-1");
	assert.equal(request?.url, "https://cloud.example.test/api/v1/projects");
	const headers = new Headers(request?.init?.headers);
	assert.equal(headers.get("authorization"), "Bearer secret-token");
	assert.equal(headers.get("idempotency-key"), "command-1");
	assert.doesNotMatch(String(request?.init?.body), /secret-token/u);
});

test("DomainApiClient preserves structured server errors and rejects malformed success", async () => {
	const denied = new DomainApiClient({
		endpoint: "https://cloud.example.test",
		getAccessToken: () => "token",
		fetch: async () =>
			jsonResponse(
				{
					protocolVersion: SUIMING_DOMAIN_API_VERSION,
					requestId: "request-denied",
					error: { code: "cloud_access_denied", message: "denied", retryable: false },
				},
				403,
			),
	});
	await assert.rejects(
		denied.readProject("project-1"),
		(error: unknown) =>
			error instanceof DomainApiClientError &&
			error.code === "cloud_access_denied" &&
			error.status === 403 &&
			error.requestId === "request-denied",
	);

	const malformed = new DomainApiClient({
		endpoint: "https://cloud.example.test",
		getAccessToken: () => "token",
		fetch: async () => jsonResponse({ ok: true }),
	});
	await assert.rejects(
		malformed.readProject("project-1"),
		(error: unknown) => error instanceof DomainApiClientError && error.code === "invalid_domain_api_response",
	);
});

test("DomainApiClient addresses project members and verifies artifact version content", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const bytes = new TextEncoder().encode("verified artifact");
	const contentSha256 = await sha256(bytes);
	const client = new DomainApiClient({
		endpoint: "https://cloud.example.test",
		getAccessToken: () => "token",
		fetch: async (input, init) => {
			const url = String(input);
			requests.push({ url, ...(init === undefined ? {} : { init }) });
			if (url.endsWith("/members/reader%2Fwest")) {
				return jsonResponse({
					protocolVersion: SUIMING_DOMAIN_API_VERSION,
					requestId: "request-member",
					data: { role: "viewer" },
				});
			}
			return jsonResponse({
				protocolVersion: SUIMING_DOMAIN_API_VERSION,
				requestId: "request-version",
				data: {
					id: "version-1",
					mediaType: "text/markdown",
					contentSha256,
					byteLength: bytes.byteLength,
					contentBase64: Buffer.from(bytes).toString("base64"),
				},
			});
		},
	});

	assert.equal(
		await client.setProjectMember({
			projectId: "project 1",
			memberActorId: "reader/west",
			role: "viewer",
			idempotencyKey: "member-1",
		}),
		"viewer",
	);
	assert.equal(requests[0]?.url, "https://cloud.example.test/v1/projects/project%201/members/reader%2Fwest");
	assert.equal(new Headers(requests[0]?.init?.headers).get("idempotency-key"), "member-1");

	const version = await client.readArtifactVersion("project 1", "version/1");
	assert.equal(version.id, "version-1");
	assert.deepEqual(version.bytes, bytes);
	assert.equal(requests[1]?.url, "https://cloud.example.test/v1/projects/project%201/artifact-versions/version%2F1");
});

test("DomainApiClient rejects an artifact version whose content metadata is inconsistent", async () => {
	const client = new DomainApiClient({
		endpoint: "https://cloud.example.test",
		getAccessToken: () => "token",
		fetch: async () =>
			jsonResponse({
				protocolVersion: SUIMING_DOMAIN_API_VERSION,
				requestId: "request-tampered",
				data: {
					id: "version-1",
					mediaType: "text/plain",
					contentSha256: "0".repeat(64),
					byteLength: 8,
					contentBase64: Buffer.from("tampered").toString("base64"),
				},
			}),
	});

	await assert.rejects(client.readArtifactVersion("project-1", "version-1"), {
		code: "content_hash_mismatch",
	});
});
