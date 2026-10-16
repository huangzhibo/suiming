/** 用 Langfuse observations API 核对本次隔离运行；只保存脱敏关联与用量。 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const folder = new URL("./", import.meta.url);
const measured = JSON.parse(await readFile(new URL("measurements.json", folder), "utf8"));
const sessions = [];
for (const local of measured.sessions) {
	const result = spawnSync(
		"npx",
		[
			"langfuse-cli",
			"api",
			"observations",
			"list",
			"--session-id",
			local.id,
			"--fields",
			"core,basic,usage,metadata",
			"--limit",
			"100",
			"--json",
		],
		{
			env: { ...process.env, LANGFUSE_HOST: process.env.LANGFUSE_BASE_URL },
			encoding: "utf8",
			timeout: 30000,
		},
	);
	assert.equal(result.status, 0, "Langfuse observations query failed");
	const response = JSON.parse(result.stdout);
	const body = response.body ?? response;
	assert.ok(body.data.length < 100, "Expand pagination before using a larger validation run");
	const observations = body.data;
	const sent = measured.batches.flatMap((b: any) => b.spans).filter((s: any) => s.sessionId === local.id);
	const missing = sent.filter((s: any) => !observations.some((o: any) => o.id === s.id)).map((s: any) => s.id);
	const unexpected = observations.filter((o: any) => !sent.some((s: any) => s.id === o.id)).map((o: any) => o.id);
	const models = observations.filter((o: any) => o.type === "GENERATION");
	const usage = models.reduce(
		(sum: any, o: any) => ({
			input: sum.input + (o.usageDetails?.input ?? 0),
			output: sum.output + (o.usageDetails?.output ?? 0),
			cacheRead: sum.cacheRead + (o.usageDetails?.input_cache_read ?? 0),
			totalTokens: sum.totalTokens + (o.usageDetails?.total ?? 0),
		}),
		{ input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
	);
	const parentsMatch = observations.every(
		(o: any) =>
			!o.parentObservationId ||
			observations.some((p: any) => p.id === o.parentObservationId && p.traceId === o.traceId),
	);
	const toolCalls = observations.filter((o: any) => o.type === "TOOL").length;
	const turns = observations.filter((o: any) => o.name === "suiming.turn agent").length;
	const complete =
		missing.length === 0 &&
		unexpected.length === 0 &&
		parentsMatch &&
		models.length === local.usage.calls &&
		toolCalls === local.actions.length &&
		turns === local.turn &&
		Object.entries(usage).every(([key, value]) => value === local.usage[key]);
	sessions.push({
		sessionId: local.id,
		complete,
		sent: sent.length,
		received: observations.length,
		modelCalls: models.length,
		localCalls: local.usage.calls,
		toolCalls,
		localTools: local.actions.length,
		turns,
		missing,
		unexpected,
		usage,
		localUsage: local.usage,
		parentsMatch,
		observations: observations.map((o: any) => ({
			id: o.id,
			traceId: o.traceId,
			parentId: o.parentObservationId,
			name: o.name,
			type: o.type,
			level: o.level,
			outcome: o.metadata?.outcome,
		})),
	});
}
const complete = sessions.every((s) => s.complete);
await writeFile(new URL("observations-summary.json", folder), JSON.stringify({ complete, sessions }, null, 2));
console.log(JSON.stringify({ complete, sessions: sessions.map(({ observations, ...summary }) => summary) }));
assert.ok(complete, "Backend observations do not reconcile with local execution and relay batches");
