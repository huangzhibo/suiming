/** 独立 CLI 进程：只注入隔离 OAuth provider，命令和 Session 路径使用产品实现。 */
import { NOOP_TELEMETRY } from "@suiming/runtime";
import { oauthFixture } from "../../../packages/runtime/test/oauth-fixture.js";
import { runSuimCli } from "../src/cli.js";

const [auth, endpoint, ...args] = process.argv.slice(2);
if (!auth || !endpoint) throw new Error("Missing isolated auth fixture");
const fixture = oauthFixture(auth, endpoint);
const modify = fixture.credentials.modify.bind(fixture.credentials);
fixture.credentials.modify = (...args) => {
	process.send?.("waiting-for-refresh-lock");
	return modify(...args);
};
process.exitCode = await runSuimCli(args, {
	cwd: () => process.cwd(),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	resolveModelGateway: async () => fixture.gateway,
	telemetry: NOOP_TELEMETRY,
});

process.disconnect?.();
