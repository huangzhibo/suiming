import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { CreateBucketCommand, DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { CloudStoreError, cloudObjectKey } from "@suiming/runtime";
import {
	createS3CloudObjectStoreResource,
	S3CloudObjectStore,
	s3CloudObjectStoreConfigFromEnvironment,
} from "../src/index.js";

const endpoint = process.env.SUIMING_TEST_S3_ENDPOINT;
const accessKeyId = process.env.SUIMING_TEST_S3_ACCESS_KEY;
const secretAccessKey = process.env.SUIMING_TEST_S3_SECRET_KEY;
const integrationEnabled = endpoint !== undefined && accessKeyId !== undefined && secretAccessKey !== undefined;

test("S3 process config supports default credentials and rejects partial explicit credentials", () => {
	assert.deepEqual(
		s3CloudObjectStoreConfigFromEnvironment({
			SUIMING_S3_REGION: "us-east-1",
			SUIMING_S3_BUCKET: "suiming",
			SUIMING_S3_ENDPOINT: "http://127.0.0.1:9000",
			SUIMING_S3_FORCE_PATH_STYLE: "true",
		}),
		{
			region: "us-east-1",
			bucket: "suiming",
			endpoint: "http://127.0.0.1:9000",
			forcePathStyle: true,
		},
	);
	assert.throws(
		() => s3CloudObjectStoreConfigFromEnvironment({}),
		(error: unknown) => error instanceof CloudStoreError && error.code === "missing_s3_config",
	);
	assert.throws(
		() =>
			s3CloudObjectStoreConfigFromEnvironment({
				SUIMING_S3_REGION: "us-east-1",
				SUIMING_S3_BUCKET: "suiming",
				SUIMING_S3_ACCESS_KEY_ID: "access-only",
			}),
		(error: unknown) => error instanceof CloudStoreError && error.code === "invalid_s3_config",
	);
});

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function errorName(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
		? error.name
		: undefined;
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error) {
		if (!new Set(["BucketAlreadyExists", "BucketAlreadyOwnedByYou"]).has(errorName(error) ?? "")) throw error;
	}
}

test("S3 CloudObjectStore 对内容寻址对象执行跨实例读写、完整性校验和幂等删除", {
	skip: integrationEnabled
		? false
		: "set SUIMING_TEST_S3_ENDPOINT, SUIMING_TEST_S3_ACCESS_KEY and SUIMING_TEST_S3_SECRET_KEY",
}, async (context) => {
	const bucket = process.env.SUIMING_TEST_S3_BUCKET ?? "suiming-integration-test";
	const keyPrefix = `runs/${randomUUID()}`;
	const resource = createS3CloudObjectStoreResource({
		endpoint: endpoint as string,
		region: process.env.SUIMING_TEST_S3_REGION ?? "us-east-1",
		forcePathStyle: true,
		bucket,
		keyPrefix,
		credentials: {
			accessKeyId: accessKeyId as string,
			secretAccessKey: secretAccessKey as string,
		},
	});
	const { client } = resource;
	context.after(() => resource.close());
	await ensureBucket(client, bucket);

	const primary = resource.objects;
	const bytes = new TextEncoder().encode("燧明 S3 object\n");
	const expected = new Uint8Array(bytes);
	const stored = await primary.put(bytes);
	bytes.fill(0);
	assert.equal(stored.contentHash, sha256(expected));
	assert.equal(stored.objectKey, cloudObjectKey(stored.contentHash));
	assert.equal(stored.byteLength, expected.byteLength);

	const restarted = new S3CloudObjectStore({ client, bucket, keyPrefix });
	assert.deepEqual(await restarted.read(stored.contentHash), expected);
	assert.deepEqual(await restarted.put(expected), stored);

	const corruptExpected = new TextEncoder().encode("expected bytes");
	const corruptHash = sha256(corruptExpected);
	const corruptPhysicalKey = `${keyPrefix}/${cloudObjectKey(corruptHash)}`;
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: corruptPhysicalKey,
			Body: new TextEncoder().encode("corrupted bytes"),
		}),
	);
	await assert.rejects(
		restarted.read(corruptHash),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_object_integrity_error",
	);

	await restarted.delete(stored.contentHash);
	await restarted.delete(stored.contentHash);
	await assert.rejects(
		restarted.read(stored.contentHash),
		(error: unknown) => error instanceof CloudStoreError && error.code === "cloud_object_not_found",
	);
	await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: corruptPhysicalKey }));
});
