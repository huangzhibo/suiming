// 向显式配置的 Langfuse 写入隔离合成观测；不调用真实模型、不读取作者作品。
import { SuimingHarness } from "../../../packages/runtime/src/harness/suiming-harness.ts";
import { telemetryFromEnvironment } from "../../../packages/runtime/src/model/telemetry.ts";
import { captureTelemetryContent } from "../../../packages/runtime/src/model/telemetry-content.ts";
import { fauxGateway, withSampleProject, say, reply, call } from "../../../packages/runtime/test/harness-fixtures.ts";
if (!process.env.LANGFUSE_BASE_URL || !process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY)
	throw new Error("请显式配置 Langfuse 地址与两项凭据。");
const results = [];
for (const capture of [false, true]) {
	const telemetry = telemetryFromEnvironment(
		{
			...process.env,
			SUIMING_TELEMETRY_CONTENT: String(capture),
			SUIMING_TELEMETRY_ENVIRONMENT: "validation",
			SUIMING_TELEMETRY_RELEASE: "langfuse-audit-20261014",
			AUDIT_SECRET: "sentinel-known-secret",
		},
		{ entrypoint: "audit" },
	);
	try {
		await withSampleProject(async (project) => {
			const models = fauxGateway(
				"observability-audit",
				[
					call("read", { path: "outline/story/index.yaml" }),
					call("review", { layer: "design", goal: "Synthetic observation check" }),
					call("submit_review", {
						verdict: "pass",
						summary: "Synthetic pass",
						findings: [],
						uncovered: [],
						uncertainties: [],
					}),
					reply("Synthetic audit completed."),
				],
				{ main: "audit-faux", reviewer: "audit-faux" },
			);
			const harness = new SuimingHarness({ project, models, telemetryContext: telemetry.context });
			const success = await say(harness, "Synthetic audit, Bearer sentinel-token.");
			results.push({
				capture,
				scenario: "completed",
				sessionId: success.sessionId,
				failure: success.failure?.code ?? null,
			});
			for (const scenario of ["failed", "stopped"]) {
				const session = await harness.createSession();
				const c = new AbortController();
				const outcome = await harness.turn(session.id, { signal: c.signal }, async () => {
					if (scenario === "stopped") c.abort();
					throw new Error("sentinel-private-error");
				});
				results.push({ capture, scenario, sessionId: session.id, failure: outcome.failure?.code ?? null });
			}
			await telemetry.context.startSpan(
				{ name: "suiming.audit.content-boundary", attributes: { "langfuse.session.id": success.sessionId } },
				async (span) => {
					captureTelemetryContent(span, "input", () => ({
						apiKey: "sentinel-api-key",
						text: "sentinel-known-secret",
						nested: { password: "sentinel-password" },
					}));
					captureTelemetryContent(span, "output", () => "长文本".repeat(50000));
				},
			);
		});
	} finally {
		await telemetry.shutdown();
	}
}
console.log(JSON.stringify(results, null, 2));
