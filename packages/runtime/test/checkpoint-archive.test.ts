import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { CheckpointArchive } from "../src/harness/checkpoint-archive.js";
import { type LoopCheckpoint, runTaskLoop } from "../src/harness/loop.js";
import { ModelGateway } from "../src/model/model-gateway.js";

function objects() {
	const values = new Map<string, Uint8Array>();
	let bytes = 0;
	return {
		values,
		get bytes() {
			return bytes;
		},
		async saveExecutionObject(mediaType: string, content: Uint8Array) {
			const id = createHash("sha256").update(mediaType).update(content).digest("hex");
			if (!values.has(id)) {
				values.set(id, content);
				bytes += content.length;
			}
			return { id };
		},
		async readExecutionObject(id: string) {
			const bytes = values.get(id);
			if (!bytes) throw new Error("missing checkpoint object");
			return { bytes };
		},
	};
}

test("checkpoint 共享节点完整往返，并在新的 archive 实例恢复", async () => {
	const store = objects();
	const archive = new CheckpointArchive(store);
	const value = {
		messages: [{ content: "原文".repeat(10000) }],
		result: { ref: "普通字段", array: [1, false, null], object: [] },
	};
	const first = await archive.write(value);
	const firstBytes = store.bytes;
	assert.deepEqual(await new CheckpointArchive(store).read((await store.readExecutionObject(first.id)).bytes), value);
	const second = await archive.write({ ...value, sequence: 2 });
	assert.ok(store.bytes - firstBytes < 2048);
	assert.notEqual(first.id, second.id);
	assert.deepEqual(await new CheckpointArchive(store).read((await store.readExecutionObject(first.id)).bytes), value);
	// 不把缺失片段默认为空消息。
	const fragment = [...store.values.keys()].find((id) => id !== first.id && id !== second.id);
	assert.ok(fragment);
	store.values.delete(fragment);
	await assert.rejects(
		new CheckpointArchive(store).read((await store.readExecutionObject(first.id)).bytes),
		/missing/,
	);
});

test("外层调用与 evidence 列表追加后保存最新值，不复用可变对象的旧编码", async () => {
	const store = objects();
	const archive = new CheckpointArchive(store);
	const value = { calls: [{ id: "first", text: "历史".repeat(2000) }] };
	await archive.write(value);
	value.calls.push({ id: "second", text: "后续".repeat(2000) });
	const saved = await archive.write(value);
	assert.deepEqual(await new CheckpointArchive(store).read((await store.readExecutionObject(saved.id)).bytes), value);
});

test("32 轮不同的 10 KB 工具结果共享历史，保存体积低于 3 MiB，原始消息仍完整", async () => {
	const store = objects();
	const archive = new CheckpointArchive(store);
	const provider = fauxProvider({ provider: "archive-test" });
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const model = await new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }).bind("main");
	provider.setResponses(Array.from({ length: 32 }, () => fauxAssistantMessage(fauxToolCall("read", {}))));
	let index = 0;
	let last = "";
	await runTaskLoop({
		model,
		systemPrompt: "test",
		prompt: "read",
		budget: { maxTurns: 32 },
		tools: [
			{
				name: "read",
				description: "read",
				replay: "read" as const,
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: `${index++}:${"x".repeat(10000)}` }] };
				},
			},
		],
		async saveCheckpoint(checkpoint) {
			last = (await archive.write(checkpoint)).id;
		},
	});
	assert.ok(store.bytes < 3 * 1024 * 1024, `checkpoint writes: ${store.bytes}`);
	const checkpoint = (await new CheckpointArchive(store).read(
		(
			await store.readExecutionObject(last)
		).bytes,
	)) as LoopCheckpoint;
	assert.equal(checkpoint.calls.length, 32);
	assert.ok(checkpoint.calls.filter((call) => call.context).length <= 2);
	assert.equal(checkpoint.messages.filter((message) => message.role === "toolResult").length, 32);
	assert.ok(JSON.stringify(checkpoint.messages).includes(`31:${"x".repeat(10000)}`));
});
