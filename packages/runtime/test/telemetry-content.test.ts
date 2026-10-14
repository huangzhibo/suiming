import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { createOpenTelemetry } from "../src/model/telemetry.js";
import { captureTelemetryContent, telemetryInput, telemetryMessages } from "../src/model/telemetry-content.js";

for (const captureContent of [false, true]) {
	test(`内容采集 ${captureContent ? "开启" : "关闭"}：隔离策略、来源传播、过滤及截断不改输入`, async () => {
		const exporter = new InMemorySpanExporter();
		const telemetry = createOpenTelemetry({
			spanProcessors: [new SimpleSpanProcessor({ exporter })],
			captureContent,
			redactValues: ["private-known-value"],
			entrypoint: "test",
			environment: "validation",
			release: "audit-build",
		});
		const input = {
			text: "public text Bearer test-token-value private-known-value",
			password: "private-password",
			nested: { apiKey: "private-api-key" },
		};
		const before = JSON.stringify(input);
		let reads = 0;
		await telemetry.context.startSpan({ name: "root" }, async (root) => {
			captureTelemetryContent(root, "input", () => {
				reads++;
				return input;
			});
			root.setAttributes({
				"langfuse.observation.metadata.action_id": "root-action",
				"langfuse.observation.metadata.outcome": "failed",
			});
			await root.startSpan({ name: "child" }, async (child) => {
				captureTelemetryContent(child, "output", () => "长文本\n".repeat(50000));
			});
		});
		const [child, root] = exporter.getFinishedSpans();
		assert.ok(root && child);
		assert.equal(reads, captureContent ? 1 : 0);
		assert.equal(JSON.stringify(input), before);
		for (const span of [child, root]) {
			assert.equal(span.attributes["langfuse.environment"], "validation");
			assert.equal(span.attributes["langfuse.release"], "audit-build");
			assert.equal(span.attributes["langfuse.observation.metadata.entrypoint"], "test");
		}
		assert.equal(child.attributes["langfuse.observation.metadata.action_id"], undefined);
		assert.equal(child.attributes["langfuse.observation.metadata.outcome"], undefined);
		if (captureContent) {
			const captured = String(root.attributes["langfuse.observation.input"]);
			assert.ok(captured.includes("public text"));
			assert.ok(!captured.includes("private-") && !captured.includes("test-token-value"));
			const large = String(child.attributes["langfuse.observation.output"]);
			assert.ok(Buffer.byteLength(large) < 64 * 1024);
			assert.equal(JSON.parse(large).truncated, true);
		} else {
			assert.equal(root.attributes["langfuse.observation.input"], undefined);
			assert.equal(child.attributes["langfuse.observation.output"], undefined);
		}
		await telemetry.shutdown();
	});
}

test("模型内容投影保留系统工具和调用结果，剔除签名、图片与原始异常；序列化失败不影响执行", async () => {
	const exporter = new InMemorySpanExporter();
	const telemetry = createOpenTelemetry({
		spanProcessors: [new SimpleSpanProcessor({ exporter })],
		captureContent: true,
	});
	const message = fauxAssistantMessage(
		fauxToolCall("read", { apiKey: "private-tool-key", path: "outline/story/index.yaml" }),
	);
	message.errorMessage = "private-error";
	message.content.push({ type: "thinking", thinking: "可见推理", thinkingSignature: "private-signature" });
	const input = {
		systemPrompt: "system instructions",
		messages: [
			{
				role: "user" as const,
				content: [{ type: "image" as const, data: "private-image", mimeType: "image/png" }],
				timestamp: 1,
			},
			message,
		],
	};
	await telemetry.context.startSpan({ name: "model" }, async (span) => {
		captureTelemetryContent(span, "input", () => telemetryInput(input));
		captureTelemetryContent(span, "output", () => telemetryMessages([message]));
	});
	await telemetry.context.startSpan({ name: "broken" }, async (span) => {
		captureTelemetryContent(span, "input", () => {
			throw new Error("private-error");
		});
	});
	const spans = exporter.getFinishedSpans();
	const captured = JSON.stringify(spans.map((s) => s.attributes));
	assert.ok(
		captured.includes("system instructions") &&
			captured.includes("可见推理") &&
			captured.includes("outline/story/index.yaml"),
	);
	assert.ok(!captured.includes("private-"));
	assert.equal(spans[1]?.attributes["langfuse.observation.metadata.input_capture_failed"], true);
	assert.deepEqual(input.messages[0]?.content[0], { type: "image", data: "private-image", mimeType: "image/png" });
	await telemetry.shutdown();
});
