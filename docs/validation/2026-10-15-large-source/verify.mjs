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
function verifyRange(task, span, beatRange) {
	assert.equal(task.status, "completed");
	const loop = result.loops.find((l) => l.id === task.id);
	const ranges = loop.actions
		.flatMap((a) => {
			if (
				a.call.name !== "read_source" ||
				a.call.arguments.sourceId !== result.sourceId ||
				a.message?.isError !== false
			)
				return [];
			const text = a.result?.content?.find((p) => p.type === "text")?.text ?? "";
			const match = /^Source "[^"]+" \[(\d+), (\d+)\)/u.exec(text);
			return match ? [[Number(match[1]), Number(match[2])]] : [];
		})
		.sort((a, b) => a[0] - b[0]);
	let cursor = span[0];
	for (const [start, end] of ranges) {
		if (cursor >= span[1]) break;
		if (end <= cursor) continue;
		assert.ok(start <= cursor, `实际读取漏掉 [${cursor},${start})`);
		cursor = end;
	}
	assert.ok(cursor >= span[1], `原文 [${span}) 没有实际读完`);
	const opening =
		typeof loop.opening.content === "string" ? loop.opening.content : JSON.stringify(loop.opening.content);
	const preloaded = [...opening.matchAll(/BEGIN ARTIFACT "([^"]+\/beat-\d+\.md)"/gu)].map((m) => m[1]);
	const deferred = [...opening.matchAll(/按需读取：(\S+\/beat-\d+\.md)/gu)].map((m) => m[1]);
	const reads = loop.actions
		.filter(
			(a) =>
				a.call.name === "read" &&
				a.result &&
				a.message?.isError === false &&
				(a.call.arguments.offset ?? 1) === 1 &&
				(a.call.arguments.column ?? 0) === 0 &&
				!a.result.content.some((p) => p.type === "text" && p.text.includes("[尚未读完；继续 read：")),
		)
		.map((a) => a.call.arguments.path);
	for (const path of deferred) assert.ok(reads.includes(path), `未读取延后文件 ${path}`);
	const available = new Set([...preloaded, ...reads]);
	const expectedPaths = Object.keys(result.targetDigests)
		.filter((p) => {
			const match = /^outline\/story\/[^/]+\/beat-(\d+)\.md$/u.exec(p);
			return match && Number(match[1]) >= beatRange.from && Number(match[1]) <= beatRange.to;
		})
		.map((p) => `source/${result.sourceId}/${p}`);
	for (const path of expectedPaths) assert.ok(available.has(path), `未检查已有情节 ${path}`);
	return {
		taskId: task.id,
		span,
		beatRange,
		preloaded: preloaded.length,
		deferred: deferred.length,
		beatsAvailable: expectedPaths.length,
		modelCalls: loop.calls.length,
		compactions: loop.calls.filter((c) => c.purpose === "compaction").length,
		firstRequestBytes: loop.calls[0].promptBytes,
		maxRequestBytes: Math.max(...loop.calls.map((c) => c.promptBytes ?? 0)),
	};
}
const verified = [verifyRange(tasks[0], [197346, 249272], { from: 401, to: 499 })];
const latest = result.followups?.at(-1) ?? result.review ?? result.complete ?? result.expand;
if (result.complete) {
	const root = result.loops.find((l) => l.id === result.sessionId);
	for (const range of result.remainingRanges) {
		const matches = latest.tasks.filter((t) => {
			if (t.kind !== "source-extractor") return false;
			const args = root.actions.find((a) => a.id === t.key)?.call.arguments;
			return (
				args?.sourceId === result.sourceId &&
				args.beatRange?.from === range.beatRange.from &&
				args.beatRange?.to === range.beatRange.to
			);
		});
		assert.equal(matches.length, 1, "每个剩余号段沿一个任务完成");
		verified.push(verifyRange(matches[0], range.span, range.beatRange));
	}
	assert.equal(
		verified.reduce((sum, r) => sum + r.beatsAvailable, 0),
		231,
	);
}
assert.deepEqual(result.final.coverage.gaps, []);
assert.match(result.final.check, /^PASSED/u);
console.log(JSON.stringify({ ranges: verified }, null, 2));
if (result.review) {
	assert.equal(result.final.status.candidate.uncommittedChanges, 0, "最终修订和审稿须提交，不能只检查候选");
	const reports = result.final.reviews.filter((r) => r.layer === "source" && r.sourceId === result.sourceId);
	assert.ok(
		reports.some((r) => r.currency.state === "current"),
		"须保留对当前全 Source 的独立审稿",
	);
	const reviewerTasks = latest.tasks.filter((t) => t.kind === "reviewer" && t.status === "completed");
	assert.ok(reviewerTasks.length > 0, "须真实独立审稿交付");
	const root = result.loops.find((l) => l.id === result.sessionId);
	const fullSourceReviews = reviewerTasks.filter((task) => {
		const args = root.actions.find((a) => a.id === task.key)?.call.arguments;
		return args?.layer === "source" && args.sourceId === result.sourceId;
	});
	assert.ok(fullSourceReviews.length > 0, "通用子任务的辅助核查不能替代标准全 Source Reviewer");
	for (const task of fullSourceReviews) {
		const loop = result.loops.find((l) => l.id === task.id);
		const opening = typeof loop.opening.content === "string" ? loop.opening.content : JSON.stringify(loop.opening.content);
		for (const path of Object.keys(result.targetDigests).filter((p) => /^outline\/story\/[^/]+\/beat-\d+\.md$/u.test(p))) {
			assert.ok(opening.includes(`BEGIN ARTIFACT "source/${result.sourceId}/${path}"`), `完整审稿输入缺少 ${path}`);
		}
	}
	console.log(
		JSON.stringify(
			{
				reviewers: fullSourceReviews.map((t) => ({ provider: t.model.provider, model: t.model.model })),
				reviews: reports.map((r) => ({
					path: r.path,
					verdict: r.draft.verdict,
					findings: r.draft.findings.length,
					currency: r.currency.state,
				})),
			},
			null,
			2,
		),
	);
}
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
	assert.ok(Math.abs(cost - latest.usage.costUsd) < 1e-7, "Langfuse 与执行用量估算不一致");
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
