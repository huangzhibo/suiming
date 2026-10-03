#!/usr/bin/env node
import { DomainApiCloudProjectStore, loadCloudConnectionConfig, useEnvironmentProxy } from "@suiming/runtime";
import { DomainApiClient } from "@suiming/sdk";
import { runSuimCli } from "./cli.js";

// 模型调用要遵守系统代理；Node 的 fetch 默认不读那些环境变量。
useEnvironmentProxy();

function cloudCredentialError(): Error & { code: string } {
	return Object.assign(new Error("必须通过 SUIMING_CLOUD_ACCESS_TOKEN 提供 Cloud access token"), {
		name: "SuimCloudConfigurationError",
		code: "cloud_credentials_missing",
	});
}

process.exitCode = await runSuimCli(process.argv.slice(2), {
	cwd: () => process.cwd(),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	onInterrupt: (handler) => {
		const once = () => handler();
		process.once("SIGINT", once);
		process.once("SIGTERM", once);
		return () => {
			process.off("SIGINT", once);
			process.off("SIGTERM", once);
		};
	},
	cloudDefaults: async (options) => (await loadCloudConnectionConfig(options)).config,
	resolveCloudProjectStore: async ({ endpoint, actorId }) =>
		new DomainApiCloudProjectStore({
			actorId,
			client: new DomainApiClient({
				endpoint,
				getAccessToken: () => {
					const token = process.env.SUIMING_CLOUD_ACCESS_TOKEN?.trim();
					if (token === undefined || token.length === 0) throw cloudCredentialError();
					return token;
				},
			}),
		}),
});
