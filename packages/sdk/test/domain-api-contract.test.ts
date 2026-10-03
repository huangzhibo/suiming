import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
	DOMAIN_API_ROUTES,
	DomainApiCodecError,
	DomainApiErrorSchema,
	DomainApiOpenStoryPackageSchema,
	DomainApiSuccessSchema,
	decodeDomainApiOpenStoryPackage,
	encodeDomainApiOpenStoryPackage,
	SUIMING_DOMAIN_API_VERSION,
} from "../src/index.js";

const contentSha256 = "a".repeat(64);
const contentFingerprint = `sha256:${"b".repeat(64)}`;

test("Open Story Package wire schema only accepts explicit current-format files", () => {
	const packageValue = {
		schemaVersion: 1,
		contentFingerprint,
		files: [
			{
				path: "story/intent.md",
				mediaType: "text/markdown; charset=utf-8",
				contentSha256,
				byteLength: 3,
				contentBase64: "YWJj",
			},
		],
	};
	assert.equal(Value.Check(DomainApiOpenStoryPackageSchema, packageValue), true);
	assert.equal(Value.Check(DomainApiOpenStoryPackageSchema, { ...packageValue, legacyVersion: 1 }), false);
	for (const path of ["../secret", "a/../secret", "/absolute", "a//b", "a/", "a\\b", ".", ".."]) {
		assert.equal(
			Value.Check(DomainApiOpenStoryPackageSchema, {
				...packageValue,
				files: [{ ...packageValue.files[0], path }],
			}),
			false,
			path,
		);
	}
});

test("Domain API envelopes freeze protocol version and reject undeclared fields", () => {
	const SuccessSchema = DomainApiSuccessSchema(DomainApiOpenStoryPackageSchema);
	const data = {
		protocolVersion: SUIMING_DOMAIN_API_VERSION,
		requestId: "request-1",
		data: {
			schemaVersion: 1,
			contentFingerprint,
			files: [
				{
					path: "story/intent.md",
					mediaType: "text/markdown",
					contentSha256,
					byteLength: 3,
					contentBase64: "YWJj",
				},
			],
		},
	};
	assert.equal(Value.Check(SuccessSchema, data), true);
	assert.equal(Value.Check(SuccessSchema, { ...data, protocolVersion: "suiming.domain.v2" }), false);
	assert.equal(
		Value.Check(DomainApiErrorSchema, {
			protocolVersion: SUIMING_DOMAIN_API_VERSION,
			requestId: "request-1",
			error: { code: "cloud_access_denied", message: "denied", retryable: false },
		}),
		true,
	);
});

test("route catalog has unique stable operations and every mutation requires idempotency", () => {
	const routes = Object.values(DOMAIN_API_ROUTES);
	assert.equal(new Set(routes.map((route) => route.operationId)).size, routes.length);
	assert.equal(new Set(routes.map((route) => `${route.method} ${route.path}`)).size, routes.length);
	for (const route of routes) {
		assert.match(route.path, /^\/v1\//u);
		if (route.method === "POST") assert.equal(route.idempotency, "required", route.operationId);
		else assert.equal(route.idempotency, "forbidden", route.operationId);
	}
});

test("Open Story Package codec round-trips bytes and rejects content tampering", async () => {
	const files = [
		{
			path: "world/characters/李牧.md",
			mediaType: "text/markdown; charset=utf-8",
			bytes: new TextEncoder().encode("证据优先。\n"),
		},
		{
			path: "intent/揭开真相.md",
			mediaType: "text/markdown; charset=utf-8",
			bytes: new TextEncoder().encode("揭开真相。\n"),
		},
	];
	const encoded = await encodeDomainApiOpenStoryPackage(files);
	const decoded = await decodeDomainApiOpenStoryPackage(encoded);
	assert.deepEqual(
		decoded.map((file) => ({ ...file, bytes: [...file.bytes] })),
		files.map((file) => ({ ...file, bytes: [...file.bytes] })),
	);

	const tampered = structuredClone(encoded);
	const tamperedFile = tampered.files[0];
	assert.ok(tamperedFile);
	tamperedFile.contentBase64 = "YWJj";
	await assert.rejects(
		decodeDomainApiOpenStoryPackage(tampered),
		(error: unknown) => error instanceof DomainApiCodecError && error.code === "content_length_mismatch",
	);
});
