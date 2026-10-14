/** 离线核对实际读取区间、预载与按需读取文件；不将派生证据写回作品。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const result = JSON.parse(await readFile(process.argv[2], "utf8"));
const interrupted = result.stop.tasks.filter((t) => t.kind === "source-extractor");
assert.equal(interrupted.length, 2);
for (const task of interrupted) {
	assert.equal(result.resume.tasks.find((t) => t.id === task.id)?.status, "completed", "沿原任务恢复");
}
assert.deepEqual(new Set(result.resume.tasks.map((t) => t.id)), new Set(result.stop.tasks.map((t) => t.id)));
const previous = new Set(result.resume.tasks.map((t) => t.id));
const tasks = result.expand.tasks.filter((t) => t.kind === "source-extractor" && !previous.has(t.id));
assert.equal(tasks.length, 1, "扩展范围只需一个补全任务");
assert.equal(tasks[0].status, "completed");
const loop = result.loops.find((l) => l.id === tasks[0].id);
const ranges = loop.actions
	.flatMap((a) => {
		if (a.call.name !== "read_source" || a.call.arguments.sourceId !== result.sourceId || a.message?.isError)
			return [];
		const text = a.result?.content?.find((p) => p.type === "text")?.text ?? "";
		const match = /^Source "[^"]+" \[(\d+), (\d+)\)/u.exec(text);
		return match ? [[Number(match[1]), Number(match[2])]] : [];
	})
	.sort((a, b) => a[0] - b[0]);
let cursor = 197346;
for (const [start, end] of ranges) {
	if (end <= cursor) continue;
	assert.ok(start <= cursor, `实际读取漏掉 [${cursor},${start})`);
	cursor = end;
}
assert.ok(cursor >= 249272, "末段原文没有实际读完");
const opening = typeof loop.opening.content === "string" ? loop.opening.content : JSON.stringify(loop.opening.content);
const preloaded = [...opening.matchAll(/BEGIN ARTIFACT "([^"]+\/beat-\d+\.md)"/gu)].map((m) => m[1]);
const deferred = [...opening.matchAll(/按需读取：(\S+\/beat-\d+\.md)/gu)].map((m) => m[1]);
const reads = loop.actions
	.filter((a) => a.call.name === "read" && a.result && a.message?.isError === false)
	.map((a) => a.call.arguments.path);
for (const path of deferred) assert.ok(reads.includes(path), `未读取延后文件 ${path}`);
const ids = new Set(
	[...preloaded, ...reads].flatMap((p) => {
		const match = /\/beat-(\d+)\.md$/u.exec(p);
		return match && Number(match[1]) >= 401 && Number(match[1]) <= 441 ? [Number(match[1])] : [];
	}),
);
assert.equal(ids.size, 41, "41 节应当全部预载或实际读取");
assert.deepEqual(result.final.coverage.gaps, []);
assert.match(result.final.check, /^PASSED/u);
console.log(
	JSON.stringify(
		{
			taskId: tasks[0].id,
			readSpans: ranges,
			readThrough: cursor,
			preloaded: preloaded.length,
			deferred: deferred.length,
			beatsAvailable: ids.size,
			modelCalls: loop.calls.length,
			compactions: loop.calls.filter((c) => c.purpose === "compaction").length,
			firstRequestBytes: loop.calls[0].promptBytes,
			maxRequestBytes: Math.max(...loop.calls.map((c) => c.promptBytes ?? 0)),
		},
		null,
		2,
	),
);
if (process.argv[3]) {
	const response = JSON.parse(await readFile(process.argv[3], "utf8"));
	const observations = (response.body ?? response).data;
	const expected = new Set(result.loops.flatMap((l) => l.calls.map((c) => c.id)));
	const calls = observations.filter((o) => o.name === "suiming.model.call");
	assert.equal(calls.length, expected.size);
	assert.deepEqual(new Set(calls.map((c) => c.metadata.model_call_id)), expected);
	assert.ok(
		observations.every((o) => o.metadata.entrypoint === "validation" && o.metadata.session_id === result.sessionId),
	);
	const owners = new Map(result.loops.flatMap((l) => l.calls.map((c) => [c.id, l.id])));
	for (const call of calls) {
		assert.equal(call.metadata.task_id ?? call.metadata.session_id, owners.get(call.metadata.model_call_id));
		assert.ok(call.metadata.turn_id, "模型调用须关联到 turn");
	}
	const cost = calls.reduce((sum, c) => sum + c.totalCost, 0);
	assert.ok(Math.abs(cost - result.expand.usage.costUsd) < 1e-7, "Langfuse 与执行用量估算不一致");
	console.log(
		JSON.stringify(
			{
				observations: observations.length,
				modelCalls: calls.length,
				costUsd: cost,
				roots: observations
					.filter((o) => o.name === "suiming.turn agent")
					.map((o) => ({ outcome: o.metadata.outcome, level: o.level })),
			},
			null,
			2,
		),
	);
}
