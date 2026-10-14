import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ActionDetailReader } from "../src/harness/action-detail.js";
import { CheckpointArchive } from "../src/harness/checkpoint-archive.js";

test("动作详情按需读取：不读取无关消息和其他动作结果，末项与并发查询完整可用", async () => {
	const objects = new Map<string, Uint8Array>();
	const store = {
		async saveExecutionObject(mediaType: string, bytes: Uint8Array) {
			const id = createHash("sha256").update(mediaType).update(bytes).digest("hex");
			objects.set(id, bytes);
			return { id };
		},
		async readExecutionObject(id: string) {
			const bytes = objects.get(id);
			assert.ok(bytes);
			return { bytes };
		},
	};
	const actions = Array.from({ length: 1314 }, (_, i) => ({
		id: `action-${i}`,
		call: { name: "read", arguments: { path: `文件-${i}` } },
		message: { content: [{ type: "text", text: `${i}：${"结果".repeat(3000)}` }], isError: i === 1313 },
	}));
	const checkpoint = await new CheckpointArchive(store).write({
		loop: { actions, messages: [{ text: "不应读的历史".repeat(10000) }] },
	});
	const wanted = actions[1313];
	assert.ok(wanted);
	let readBytes = 0;
	let failOnce = false;
	const reader = new ActionDetailReader({
		...store,
		async readExecutionObject(id) {
			const result = await store.readExecutionObject(id);
			const text = new TextDecoder().decode(result.bytes);
			assert.ok(!text.includes("不应读的历史"), "点开动作不应解开整个消息列表");
			if (text.includes("1313：") && failOnce) {
				failOnce = false;
				throw new Error("temporary read failure");
			}
			readBytes += result.bytes.length;
			return result;
		},
	});
	failOnce = true;
	await assert.rejects(reader.read(checkpoint.id, wanted.id), /temporary read failure/);
	const [last, first] = await Promise.all([
		reader.read(checkpoint.id, wanted.id),
		reader.read(checkpoint.id, "action-0"),
	]);
	assert.equal(last?.output, wanted.message.content[0]?.text);
	assert.equal(last?.isError, true);
	assert.equal(first?.input.path, "文件-0");
	assert.ok(readBytes < 2_000_000, `只读索引节点和所选结果，不应加载全部 23 MB 结果，实际 ${readBytes}`);
	assert.equal(await reader.read(checkpoint.id, "missing"), undefined);
	if (last) last.input.path = "外部改动";
	assert.equal((await reader.read(checkpoint.id, wanted.id))?.input.path, "文件-1313");
	// 内联恢复点也保留原语义；输出截断按码点，不截半个 emoji。
	const inline = await store.saveExecutionObject(
		"application/json",
		new TextEncoder().encode(
			JSON.stringify({
				loop: {
					actions: [
						{
							id: "inline",
							call: { name: "write", arguments: null },
							message: { content: [{ type: "text", text: "😀".repeat(100001) }], isError: true },
						},
					],
				},
			}),
		),
	);
	const detail = await reader.read(inline.id, "inline");
	assert.deepEqual(detail?.input, { arguments: null });
	assert.equal(Array.from(detail?.output ?? "").length, 100000);
	assert.equal(detail?.truncated, true);
});
