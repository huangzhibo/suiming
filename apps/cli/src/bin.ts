#!/usr/bin/env node
import { useEnvironmentProxy } from "@suiming/runtime";
import { runSuimCli } from "./cli.js";

// 模型调用要遵守系统代理；Node 的 fetch 默认不读那些环境变量。
useEnvironmentProxy();

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
});
