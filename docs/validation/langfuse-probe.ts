/** 在显式配置的 Langfuse 中写入合成观测；不访问真实作品或模型。运行方式见审查报告。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import {
	createOpenTelemetry,
	langfuseExportOptions,
	LocalProjectService,
	materializeOpenStoryDirectorySnapshot,
	ModelGateway,
	resumeRun,
	runAgent,
	SuimingHarness,
} from "../../packages/runtime/src/index.js";
import { traceModelCall } from "../../packages/runtime/src/model/model-call-telemetry.js";
import { sampleWorkFiles } from "../../packages/runtime/test/sample-work.js";

const baseUrl = process.env.LANGFUSE_BASE_URL;
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
assert.ok(baseUrl && publicKey && secretKey, "必须显式配置 Langfuse URL 和项目 keys");
const config = langfuseExportOptions({ baseUrl, publicKey, secretKey });
const memory = new InMemorySpanExporter();
const telemetry = createOpenTelemetry({
	spanProcessors: [
		new SimpleSpanProcessor({ exporter: memory }),
		new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ ...config, timeoutMillis: 1500 }) }),
	],
});
const root = await mkdtemp(join(tmpdir(), "suiming-langfuse-probe-"));
const started = new Date().toISOString();
let project: LocalProjectService | undefined;
try {
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	project = await LocalProjectService.init({ checkoutPath: root, projectId: "langfuse-synthetic-validation" });
	const faux = fauxProvider({ provider: "langfuse-validation-faux" });
	const models = createModels();
	models.setProvider(faux.provider);
	const profile = { provider: faux.provider.id, model: faux.getModel().id };
	const gateway = new ModelGateway(models, { profiles: { main: profile, reviewer: profile } });
	const harness = new SuimingHarness({ project, models: gateway, telemetryContext: telemetry.context });
	const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args));
	faux.setResponses([
		call("write", {
			path: "intent/揭开真相.md",
			content: "Synthetic Langfuse validation: choices have irreversible consequences.",
		}),
		call("review", { layer: "design", goal: "Synthetic review" }),
		call("submit_review", {
			verdict: "pass",
			summary: "Synthetic pass",
			findings: [],
			uncovered: [],
			uncertainties: [],
		}),
		call("commit", { summary: "Synthetic commit" }),
		call("finish", { summary: "Synthetic done" }),
		call("ask_author", { question: "Synthetic pause?" }),
		call("finish", { summary: "Synthetic resumed" }),
	]);
	const first = await runAgent(harness, { goal: "Synthetic Langfuse integration validation" });
	await assert.rejects(
		runAgent(harness, { goal: "Synthetic pause and resume", conversationId: first.run.conversationId }),
		{ code: "run_waiting_input" },
	);
	const before = project.loadExecutionState();
	const paused = before.runs.find((run) => run.status === "interrupted");
	assert.ok(paused);
	const attemptIds = before.attempts.map((a) => a.id);
	project.queueRunSteering(paused.id, "Continue synthetic probe");
	await resumeRun(harness, { runId: paused.id });
	assert.deepEqual(
		project.loadExecutionState().attempts.map((a) => a.id),
		attemptIds,
	);
	const bound = await gateway.bind("main");
	await telemetry.context.startSpan(
		{
			name: "suiming.validation.exact-usage",
			attributes: {
				"langfuse.session.id": first.run.conversationId,
				"langfuse.trace.tags": ["synthetic-validation"],
			},
		},
		async (span) => {
			await traceModelCall(span, bound.snapshot, async () => ({
				...fauxAssistantMessage("Synthetic output"),
				usage: {
					input: 100,
					output: 20,
					cacheRead: 40,
					cacheWrite: 10,
					totalTokens: 170,
					cost: { input: 0.001, output: 0.002, cacheRead: 0.0004, cacheWrite: 0.0001, total: 0.0035 },
				},
			}));
		},
	);
	await telemetry.flush();
	const sent = memory.getFinishedSpans();
	type Observation = {
		id: string;
		traceId: string;
		name: string;
		parentObservationId: string | null;
		sessionId: string;
		usageDetails: Record<string, number>;
		totalCost: number | null;
		totalUsage: number;
		input: unknown;
		output: unknown;
	};
	let observations: Observation[] = [];
	for (let i = 0; i < 20; i++) {
		const url = new URL("/api/public/v2/observations", baseUrl);
		url.search = new URLSearchParams({
			sessionId: first.run.conversationId,
			fromStartTime: started,
			toStartTime: new Date().toISOString(),
			fields: "core,basic,usage,io",
			limit: "100",
		}).toString();
		const response = await fetch(url, { headers: config.headers, signal: AbortSignal.timeout(5000) });
		assert.equal(response.status, 200);
		observations = ((await response.json()) as { data: Observation[] }).data;
		if (observations.length === sent.length) break;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	assert.equal(observations.length, sent.length, "按 session 查询必须包含全部 observation");
	assert.equal(new Set(observations.map((o) => o.id)).size, sent.length, "不能重复导出同一 observation");
	for (const span of sent) {
		const row = observations.find((o) => o.id === span.spanContext().spanId);
		assert.ok(row);
		assert.equal(row.parentObservationId, span.parentSpanContext?.spanId ?? null);
		assert.ok(row.input == null && row.output == null);
	}
	const usage = observations.find((o) => o.totalCost === 0.0035);
	assert.ok(usage);
	assert.equal(usage.totalUsage, 170);
	assert.equal(usage.usageDetails.input_cache_read, 40);
	assert.equal(usage.usageDetails.input_cache_write, 10);
	console.log(
		JSON.stringify(
			{
				status: "passed",
				observationCount: observations.length,
				traceIds: [...new Set(observations.map((o) => o.traceId))],
				sessionId: first.run.conversationId,
				usage: usage.usageDetails,
				cost: usage.totalCost,
				sameAttemptResume: true,
			},
			null,
			2,
		),
	);
} finally {
	project?.close();
	await rm(root, { recursive: true, force: true });
	await telemetry.shutdown();
}
