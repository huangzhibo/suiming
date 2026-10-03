import {
	type CreateCloudPostgresDatabaseOptions,
	createCloudPostgresDatabase,
	createPostgresCloudStores,
	migrateCloudPostgres,
} from "@suiming/cloud-postgres";
import { type CreateS3CloudObjectStoreResourceOptions, createS3CloudObjectStoreResource } from "@suiming/cloud-s3";
import { CloudProjectService } from "@suiming/runtime";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import type { DomainApiAuthenticator } from "./domain-api-handler.js";
import { DomainApiHandler } from "./domain-api-handler.js";
import { createSuimingApiServer } from "./server.js";

export interface DurableSuimingApiServerOptions {
	postgres: CreateCloudPostgresDatabaseOptions;
	s3: CreateS3CloudObjectStoreResourceOptions;
	authenticate: DomainApiAuthenticator;
	inlineTextThresholdBytes?: number;
	requestId?: () => string;
	logger?: FastifyServerOptions["logger"];
}

/**
 * Owns migration, PostgreSQL/S3 adapters, the Project service and their ordered shutdown.
 * Cloud 只有 Canon 与同步，没有执行（2026-09-13 删掉了 Cloud 执行 adapter）。
 */
export async function createDurableSuimingApiServer(options: DurableSuimingApiServerOptions): Promise<FastifyInstance> {
	const database = createCloudPostgresDatabase(options.postgres);
	const s3 = createS3CloudObjectStoreResource(options.s3);
	let closed = false;
	const closeResources = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		try {
			await database.destroy();
		} finally {
			s3.close();
		}
	};
	try {
		await migrateCloudPostgres(database);
		const stores = createPostgresCloudStores({
			database,
			objects: s3.objects,
			...(options.inlineTextThresholdBytes === undefined
				? {}
				: { inlineTextThresholdBytes: options.inlineTextThresholdBytes }),
		});
		const projects = new CloudProjectService(stores.projects);
		return await createSuimingApiServer({
			domainApi: new DomainApiHandler({
				projects,
				authenticate: options.authenticate,
				...(options.requestId === undefined ? {} : { requestId: options.requestId }),
			}),
			closeResources,
			...(options.logger === undefined ? {} : { logger: options.logger }),
		});
	} catch (error) {
		await closeResources();
		throw error;
	}
}
