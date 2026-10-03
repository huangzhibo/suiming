import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { LocalProjectService, materializeOpenStoryDirectorySnapshot } from "@suiming/runtime";
import type { DesktopBridge } from "@suiming/sdk";
import { _electron as electron } from "playwright";
import { sampleWorkFiles } from "../../../packages/runtime/test/sample-work.js";

declare const window: { suiming: DesktopBridge };
type Span = { name: string; traceId: string; attributes: { key: string; value: { stringValue?: string } }[] };
test("桌面通过主进程环境接入 OTLP，退出导出最后一批 span", { timeout: 60000 }, async () => {
	const received: Span[] = [];
	const headers: string[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const raw = Buffer.concat(chunks);
		const body = JSON.parse((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString()) as {
			resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
		};
		headers.push(String(req.headers["x-langfuse-ingestion-version"]));
		for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans) received.push(...scope.spans);
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const directory = await mkdtemp(join(tmpdir(), "suiming-telemetry-desktop-"));
	const root = join(directory, "work");
	await mkdir(root);
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	(await LocalProjectService.init({ checkoutPath: root })).close();
	const app = await electron.launch({
		args: [
			resolve("apps/desktop/test-dist/entry.js"),
			"--telemetry-test",
			`--project=${root}`,
			`--user-data-dir=${join(directory, "app")}`,
		],
		env: {
			...process.env,
			LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}`,
			LANGFUSE_PUBLIC_KEY: "pk-test",
			LANGFUSE_SECRET_KEY: "sk-test",
		},
	});
	let closed = false;
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => !!window.suiming);
		const result = await page.evaluate(() =>
			window.suiming.invoke("session.send", {
				commandId: "telemetry-test",
				text: "Synthetic telemetry probe",
			}),
		);
		const deadline = Date.now() + 10000;
		let completed = false;
		while (Date.now() < deadline) {
			completed = await page.evaluate(
				async (sessionId) =>
					(await window.suiming.invoke("session.list", {})).sessions.some(
						(session) => session.id === sessionId && session.status === "idle" && session.turn === 1,
					),
				result.sessionId,
			);
			if (completed) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.ok(completed, "等待整个 turn 结束后再验收退出导出");
		await app.close();
		closed = true;
		assert.ok(received.some((s) => s.name === "suiming.turn agent"));
		assert.ok(received.some((s) => s.name === "suiming.model.call"));
		assert.ok(received.some((s) => s.name === "suiming.tool read"));
		assert.equal(new Set(received.map((s) => s.traceId)).size, 1);
		for (const span of received)
			assert.equal(
				span.attributes.find((a) => a.key === "langfuse.session.id")?.value.stringValue,
				result.sessionId,
			);
		assert.ok(headers.length > 0 && headers.every((header) => header === "4"));
	} finally {
		if (!closed) await app.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(directory, { recursive: true, force: true });
	}
});
