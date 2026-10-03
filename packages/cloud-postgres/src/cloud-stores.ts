import type { CloudObjectStore } from "@suiming/runtime";
import type { CloudPostgresDatabase } from "./database.js";
import { PostgresCloudProjectStore } from "./project-store.js";

export interface CreatePostgresCloudStoresOptions {
	database: CloudPostgresDatabase;
	objects: CloudObjectStore;
	inlineTextThresholdBytes?: number;
	now?: () => Date;
}

export interface PostgresCloudStores {
	projects: PostgresCloudProjectStore;
}

/**
 * Cloud 只保留 Canon 与同步（2026-09-13 删掉了执行 adapter）：一个数据库、一个对象存储、一个 Project store。
 * 解冻 Cloud 执行时的接口位置是 Runtime 的 `HarnessProjectPort`，不是这里。
 */
export function createPostgresCloudStores(options: CreatePostgresCloudStoresOptions): PostgresCloudStores {
	return {
		projects: new PostgresCloudProjectStore({
			database: options.database,
			objects: options.objects,
			...(options.now === undefined ? {} : { now: options.now }),
			...(options.inlineTextThresholdBytes === undefined
				? {}
				: { inlineTextThresholdBytes: options.inlineTextThresholdBytes }),
		}),
	};
}
