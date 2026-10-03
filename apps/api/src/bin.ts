#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { cloudPostgresConfigFromEnvironment } from "@suiming/cloud-postgres";
import { s3CloudObjectStoreConfigFromEnvironment } from "@suiming/cloud-s3";
import { createBearerTokenAuthenticator } from "./domain-api-handler.js";
import { createDurableSuimingApiServer } from "./durable-composition.js";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value.length === 0 || value.includes("\0")) {
		throw new Error(`${name} must be configured`);
	}
	return value;
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
	const value = process.env[name]?.trim();
	if (value === undefined || value.length === 0) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}`);
	}
	return parsed;
}

function equalSecret(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

async function main(): Promise<void> {
	const actorId = required("SUIMING_CLOUD_ACTOR_ID");
	const accessToken = required("SUIMING_CLOUD_ACCESS_TOKEN");
	const server = await createDurableSuimingApiServer({
		postgres: cloudPostgresConfigFromEnvironment(process.env, "suiming-api"),
		s3: s3CloudObjectStoreConfigFromEnvironment(process.env),
		authenticate: createBearerTokenAuthenticator((token) =>
			equalSecret(token, accessToken) ? { actorId } : undefined,
		),
		inlineTextThresholdBytes: integer(
			"SUIMING_CLOUD_INLINE_TEXT_THRESHOLD_BYTES",
			256 * 1024,
			0,
			Number.MAX_SAFE_INTEGER,
		),
		logger: true,
	});
	let stopping: Promise<void> | undefined;
	const stop = (): void => {
		stopping ??= server.close();
		void stopping.catch((error: unknown) => {
			process.stderr.write(
				`Suiming API shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const address = await server.listen({
			host: process.env.SUIMING_API_HOST?.trim() || "127.0.0.1",
			port: integer("SUIMING_API_PORT", 3001, 1, 65_535),
		});
		process.stdout.write(`Suiming API listening at ${address}\n`);
	} catch (error) {
		await server.close();
		throw error;
	}
}

await main().catch((error: unknown) => {
	process.stderr.write(`Suiming API failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
