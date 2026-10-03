import assert from "node:assert/strict";
import test from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import {
	createOpenTelemetry,
	langfuseExportOptions,
	NOOP_TELEMETRY,
	type SuimingTelemetrySpan,
	telemetryFromEnvironment,
} from "../src/index.js";

function harness() {
	const exporter = new InMemorySpanExporter();
	const telemetry = createOpenTelemetry({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
	return { exporter, telemetry };
}

test("OpenTelemetry 桥：回调作用域决定父子关系，span 带 traceId，属性与状态按 pi-telemetry 语义落地", async () => {
	const { exporter, telemetry } = harness();
	let outerIds: { traceId: string; spanId: string } | undefined;
	let innerIds: { traceId: string; spanId: string } | undefined;
	const value = await telemetry.context.startSpan(
		{ name: "outer", attributes: { "suiming.kind": "outer", tags: ["a", "b"], skipped: undefined } },
		async (outer) => {
			outerIds = {
				traceId: (outer as SuimingTelemetrySpan).traceId,
				spanId: (outer as SuimingTelemetrySpan).spanId,
			};
			outer.addEvent("checkpoint", { turn: 1 });
			return outer.startSpan({ name: "inner" }, async (inner) => {
				innerIds = {
					traceId: (inner as SuimingTelemetrySpan).traceId,
					spanId: (inner as SuimingTelemetrySpan).spanId,
				};
				inner.setAttributes({ "gen_ai.usage.input_tokens": 12 });
				inner.setStatus({ status: "ok" });
				return 42;
			});
		},
	);
	assert.equal(value, 42);
	await telemetry.flush();
	const spans = exporter.getFinishedSpans();
	assert.deepEqual(
		spans.map((span) => span.name),
		["inner", "outer"],
	);
	const inner = spans[0];
	const outer = spans[1];
	assert.ok(inner !== undefined && outer !== undefined);
	assert.ok(outerIds !== undefined && innerIds !== undefined);
	assert.equal(outer.spanContext().traceId, outerIds.traceId);
	assert.equal(outer.spanContext().spanId, outerIds.spanId);
	assert.equal(inner.spanContext().traceId, outerIds.traceId, "子 span 与父 span 同一 trace");
	assert.equal(inner.parentSpanContext?.spanId, outerIds.spanId);
	assert.deepEqual(outer.attributes, { "suiming.kind": "outer", tags: ["a", "b"] });
	assert.deepEqual(
		outer.events.map((event) => [event.name, event.attributes]),
		[["checkpoint", { turn: 1 }]],
	);
	assert.equal(inner.attributes["gen_ai.usage.input_tokens"], 12);
	assert.equal(inner.status.code, SpanStatusCode.OK);
	await telemetry.shutdown();
});

test("OpenTelemetry 桥：回调抛错自动记 error 状态，显式状态优先；错误照常抛回调用方", async () => {
	const { exporter, telemetry } = harness();
	await assert.rejects(
		telemetry.context.startSpan({ name: "failing" }, async () => {
			throw new TypeError("boom");
		}),
		(error: unknown) => error instanceof TypeError,
	);
	await assert.rejects(
		telemetry.context.startSpan({ name: "explicit" }, (span) => {
			span.setStatus({ status: "ok" });
			throw new Error("ignored by status");
		}),
	);
	await telemetry.flush();
	const [failing, explicit] = exporter.getFinishedSpans();
	assert.ok(failing !== undefined && explicit !== undefined);
	assert.equal(failing.status.code, SpanStatusCode.ERROR);
	assert.equal(failing.status.message, "Operation failed");
	assert.equal(failing.attributes["error.type"], "TypeError");
	assert.equal(explicit.status.code, SpanStatusCode.OK, "显式 setStatus 不被自动错误状态覆盖");
	await telemetry.shutdown();
});

test("Langfuse 导出参数：OTLP HTTP traces 端点与 Basic auth；没有 key 时 telemetry 是 NOOP", async () => {
	assert.deepEqual(
		langfuseExportOptions({ baseUrl: "http://localhost:3000/", publicKey: "pk-lf-a", secretKey: "sk-lf-b" }),
		{
			url: "http://localhost:3000/api/public/otel/v1/traces",
			headers: {
				"x-langfuse-ingestion-version": "4",
				Authorization: `Basic ${Buffer.from("pk-lf-a:sk-lf-b").toString("base64")}`,
			},
		},
	);
	assert.equal(telemetryFromEnvironment({}), NOOP_TELEMETRY);
	assert.equal(telemetryFromEnvironment({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "" }), NOOP_TELEMETRY);
	const langfuse = telemetryFromEnvironment({
		LANGFUSE_PUBLIC_KEY: "pk",
		LANGFUSE_SECRET_KEY: "sk",
		LANGFUSE_BASE_URL: "http://127.0.0.1:1",
	});
	assert.notEqual(langfuse, NOOP_TELEMETRY);
	// 有界 flush：后端不可达也在超时内返回，不阻塞退出。
	await langfuse.context.startSpan({ name: "unreachable" }, async () => undefined);
	const started = Date.now();
	await langfuse.flush(200);
	assert.ok(Date.now() - started < 5000);
	await langfuse.shutdown();
});

test("关联维度传给子 observation，Task 覆盖父值，用量与错误不继承", async () => {
	const { exporter, telemetry } = harness();
	await telemetry.context.startSpan(
		{
			name: "turn",
			attributes: {
				"langfuse.session.id": "session-test",
				"suiming.session.id": "session-test",
				"suiming.task.id": "parent",
				"gen_ai.usage.input_tokens": 123,
			},
		},
		async (parent) => {
			parent.setAttributes({ "suiming.turn.id": "turn-switched" });
			await parent.startSpan({ name: "child", attributes: { "suiming.task.id": "child" } }, async (child) => {
				await child.startSpan({ name: "model" }, async () => undefined);
			});
		},
	);
	const model = exporter.getFinishedSpans().find((s) => s.name === "model");
	assert.equal(model?.attributes["langfuse.session.id"], "session-test");
	assert.equal(model?.attributes["langfuse.observation.metadata.session_id"], "session-test");
	assert.equal(model?.attributes["langfuse.observation.metadata.task_id"], "child");
	assert.equal(model?.attributes["langfuse.observation.metadata.turn_id"], "turn-switched");
	assert.equal(model?.attributes["gen_ai.usage.input_tokens"], undefined);
	await telemetry.shutdown();
});

test("观测 flush / shutdown 超时和故障均不抛回业务，诊断不包含原始异常", async () => {
	const diagnostics: string[] = [];
	const telemetry = createOpenTelemetry({
		onDiagnostic: (code) => diagnostics.push(code),
		spanProcessors: [
			{
				onStart() {},
				onEnd() {},
				forceFlush: async () => {
					throw new Error("secret-token");
				},
				shutdown: () => new Promise<void>(() => {}),
			},
		],
	});
	await telemetry.flush(30);
	const start = Date.now();
	await telemetry.shutdown(30);
	assert.ok(Date.now() - start < 500);
	assert.deepEqual(diagnostics, ["telemetry_failed", "telemetry_timeout"]);
});
