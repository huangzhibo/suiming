import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLangfuseTelemetry } from "../src/model/telemetry.js";

test("Langfuse 首批慢响应不被应用的短超时丢弃，失败诊断可定位批次且不泄露内容", async () => {
	let status = 200;
	let delay = 1800;
	const diagnostics: { code: string; details: unknown }[] = [];
	const server = createServer(async (req, res) => {
		for await (const _chunk of req) {
			/* 接收真实 OTLP 请求 */
		}
		await new Promise((resolve) => setTimeout(resolve, delay));
		res.writeHead(status, { "content-type": "application/json" });
		res.end(status === 200 ? "{}" : "private-response-secret");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const telemetry = createLangfuseTelemetry({
		baseUrl: `http://127.0.0.1:${address.port}`,
		publicKey: "private-key",
		secretKey: "private-secret",
		onDiagnostic: (code, details?: unknown) => diagnostics.push({ code, details }),
	});
	try {
		await telemetry.context.startSpan({ name: "cold-start" }, async () => undefined);
		await telemetry.flush();
		assert.equal(diagnostics.length, 0, "1.8 秒的正常响应不应被 1.5 秒超时丢掉");
		delay = 0;
		status = 400;
		for (let i = 0; i < 2; i++) {
			await telemetry.context.startSpan({ name: "private-input" }, async () => undefined);
			await telemetry.flush();
		}
		const failures = diagnostics.filter((d) => d.code === "langfuse_export_failed");
		assert.equal(failures.length, 2, "每个失败批次都可追踪，不只记录首次失败");
		for (const diagnostic of failures) {
			assert.equal(diagnostic.code, "langfuse_export_failed");
			const details = diagnostic.details as {
				reason: string;
				statusCode: number;
				spanCount: number;
				spanIds: string[];
			};
			assert.equal(details.reason, "http");
			assert.equal(details.statusCode, 400);
			assert.equal(details.spanCount, 1);
			assert.match(details.spanIds[0] ?? "", /^[a-f0-9]{16}$/);
		}
		assert.doesNotMatch(JSON.stringify(diagnostics), /private-/);
		status = 200;
		await telemetry.context.startSpan({ name: "recovered" }, async () => undefined);
		await telemetry.flush();
		assert.equal(diagnostics.at(-1)?.code, "langfuse_export_recovered");
	} finally {
		await telemetry.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
