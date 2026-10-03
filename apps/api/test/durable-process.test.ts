import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import { encodeDomainApiOpenStoryPackage } from "@suiming/sdk";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

const postgresUrl = process.env.SUIMING_TEST_POSTGRES_URL;
const s3Endpoint = process.env.SUIMING_TEST_S3_ENDPOINT;
const s3AccessKey = process.env.SUIMING_TEST_S3_ACCESS_KEY;
const s3SecretKey = process.env.SUIMING_TEST_S3_SECRET_KEY;
const enabled =
	process.env.SUIMING_TEST_DURABLE_PROCESS === "1" &&
	postgresUrl !== undefined &&
	s3Endpoint !== undefined &&
	s3AccessKey !== undefined &&
	s3SecretKey !== undefined;

const childOutput = new WeakMap<ChildProcess, string>();

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error === undefined ? resolve() : reject(error))),
	);
	return address.port;
}

async function startChild(script: string, environment: NodeJS.ProcessEnv, marker: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["--import", "tsx", script], {
		cwd: process.cwd(),
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	childOutput.set(child, "");
	return new Promise<ChildProcess>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Timed out waiting for ${marker}: ${childOutput.get(child) ?? ""}`));
		}, 10_000);
		const append = (chunk: Buffer): void => {
			const output = `${childOutput.get(child) ?? ""}${chunk.toString("utf8")}`;
			childOutput.set(child, output);
			if (output.includes(marker)) {
				clearTimeout(timer);
				resolve(child);
			}
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(
				new Error(
					`Child exited before ${marker} (code=${String(code)}, signal=${String(signal)}): ${childOutput.get(child) ?? ""}`,
				),
			);
		});
	});
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
	if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		let finished = false;
		const done = (): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			done();
		}, 5_000);
		child.once("exit", done);
		child.kill("SIGTERM");
	});
}

async function runCli(cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<unknown> {
	const script = join(process.cwd(), "apps", "cli", "src", "bin.ts");
	const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
	const child = spawn(tsx, [script, "--json", ...args], {
		cwd,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timed out: ${args.join(" ")}`));
		}, 15_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
	assert.equal(exitCode, 0, `${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`);
	return JSON.parse(stdout);
}

function authorization(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

test("durable 进程：API 进程重启前后，suim Cloud sync 跨进程 import / push / checkout / pull", {
	skip: enabled ? false : "set SUIMING_TEST_DURABLE_PROCESS=1 with disposable PostgreSQL and S3 integration services",
}, async () => {
	const bucket = process.env.SUIMING_TEST_S3_BUCKET ?? "suiming-integration-test";
	const region = process.env.SUIMING_TEST_S3_REGION ?? "us-east-1";
	const bootstrap = new S3Client({
		endpoint: s3Endpoint as string,
		region,
		forcePathStyle: true,
		credentials: { accessKeyId: s3AccessKey as string, secretAccessKey: s3SecretKey as string },
	});
	try {
		await bootstrap.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		if (name !== "BucketAlreadyExists" && name !== "BucketAlreadyOwnedByYou") throw error;
	} finally {
		bootstrap.destroy();
	}

	const port = await freePort();
	const projectId = `project-process-${randomUUID()}`;
	const token = `token-${randomUUID()}`;
	const keyPrefix = `process/${randomUUID()}`;
	const commonEnvironment: NodeJS.ProcessEnv = {
		...process.env,
		SUIMING_POSTGRES_URL: postgresUrl as string,
		SUIMING_S3_REGION: region,
		SUIMING_S3_BUCKET: bucket,
		SUIMING_S3_ENDPOINT: s3Endpoint as string,
		SUIMING_S3_FORCE_PATH_STYLE: "true",
		SUIMING_S3_KEY_PREFIX: keyPrefix,
		SUIMING_S3_ACCESS_KEY_ID: s3AccessKey as string,
		SUIMING_S3_SECRET_ACCESS_KEY: s3SecretKey as string,
		SUIMING_CLOUD_INLINE_TEXT_THRESHOLD_BYTES: "0",
	};
	const apiEnvironment: NodeJS.ProcessEnv = {
		...commonEnvironment,
		SUIMING_CLOUD_ACTOR_ID: "process-owner",
		SUIMING_CLOUD_ACCESS_TOKEN: token,
		SUIMING_API_PORT: String(port),
	};
	const apiScript = join(process.cwd(), "apps", "api", "src", "bin.ts");
	let api: ChildProcess | undefined;
	try {
		api = await startChild(apiScript, apiEnvironment, "Suiming API listening at");
		const baseUrl = `http://127.0.0.1:${String(port)}`;
		const packageData = await encodeDomainApiOpenStoryPackage(sampleWorkFiles());
		const imported = await fetch(`${baseUrl}/v1/projects`, {
			method: "POST",
			headers: {
				...authorization(token),
				"content-type": "application/json",
				"idempotency-key": "process-import",
			},
			body: JSON.stringify({ projectId, package: packageData }),
		});
		const importedText = await imported.text();
		assert.equal(imported.status, 201, importedText);
		const importedBody = JSON.parse(importedText);
		const baseRevisionId = importedBody.data.revision.id as string;

		const project = await fetch(`${baseUrl}/v1/projects/${projectId}`, { headers: authorization(token) });
		assert.equal(project.status, 200);
		const projectBody = (await project.json()) as { data: { headRevisionId: string } };
		assert.equal(projectBody.data.headRevisionId, baseRevisionId);

		// API 重启后 Project 与 Cloud sync 仍可用。Cloud 没有执行，Agent 等引擎 host 解冻后再覆盖。
		await stopChild(api);
		api = undefined;
		api = await startChild(apiScript, apiEnvironment, "Suiming API listening at");

		const primaryRoot = await mkdtemp(join(tmpdir(), "suiming-process-primary-"));
		const checkoutRoot = await mkdtemp(join(tmpdir(), "suiming-process-checkout-"));
		const checkoutPath = join(checkoutRoot, "story");
		try {
			await materializeOpenStoryDirectorySnapshot(primaryRoot, sampleWorkFiles());
			const cliEnvironment = { ...process.env, SUIMING_CLOUD_ACCESS_TOKEN: token };
			assert.equal(((await runCli(primaryRoot, ["init", primaryRoot], cliEnvironment)) as { ok: boolean }).ok, true);
			const syncProjectId = `project-sync-${randomUUID()}`;
			assert.equal(
				(
					(await runCli(
						primaryRoot,
						[
							"cloud",
							"import",
							syncProjectId,
							"--endpoint",
							baseUrl,
							"--actor",
							"process-owner",
							"--idempotency-key",
							"process-sync-import",
						],
						cliEnvironment,
					)) as { ok: boolean }
				).ok,
				true,
			);

			const intentPath = join(primaryRoot, "intent", "揭开真相.md");
			await appendFile(intentPath, "\n跨进程 Cloud push 约束。\n");
			assert.equal(((await runCli(primaryRoot, ["commit"], cliEnvironment)) as { ok: boolean }).ok, true);
			assert.equal(
				(
					(await runCli(
						primaryRoot,
						["cloud", "push", "--actor", "process-owner", "--idempotency-key", "process-sync-push-1"],
						cliEnvironment,
					)) as { ok: boolean }
				).ok,
				true,
			);
			assert.equal(
				(
					(await runCli(
						primaryRoot,
						["cloud", "checkout", syncProjectId, checkoutPath, "--endpoint", baseUrl, "--actor", "process-owner"],
						cliEnvironment,
					)) as { ok: boolean }
				).ok,
				true,
			);
			assert.match(await readFile(join(checkoutPath, "intent", "揭开真相.md"), "utf8"), /Cloud push/u);

			const characterPath = join(checkoutPath, "world", "characters", "李牧.md");
			await appendFile(characterPath, "\nCloud checkout 跨进程追加事实。\n");
			assert.equal(((await runCli(checkoutPath, ["commit"], cliEnvironment)) as { ok: boolean }).ok, true);
			assert.equal(
				(
					(await runCli(
						checkoutPath,
						["cloud", "push", "--actor", "process-owner", "--idempotency-key", "process-sync-push-2"],
						cliEnvironment,
					)) as { ok: boolean }
				).ok,
				true,
			);
			assert.equal(
				(
					(await runCli(primaryRoot, ["cloud", "pull", "--actor", "process-owner"], cliEnvironment)) as {
						ok: boolean;
					}
				).ok,
				true,
			);
			assert.match(await readFile(join(primaryRoot, "world", "characters", "李牧.md"), "utf8"), /跨进程追加/u);
		} finally {
			await Promise.all([
				rm(primaryRoot, { recursive: true, force: true }),
				rm(checkoutRoot, { recursive: true, force: true }),
			]);
		}
	} finally {
		await stopChild(api);
	}
});
