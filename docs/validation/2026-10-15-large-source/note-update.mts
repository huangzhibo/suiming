/** 真实模型定向回归：已有号段笔记可更新，不给文件另加版本后缀。使用公开的两节测试 fixture。 */
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	JsonFileCredentialStore,
	loadModelRoutingConfig,
	LocalProjectService,
	ModelGateway,
	SuimingHarness,
	telemetryFromEnvironment,
	useEnvironmentProxy,
	sourceCoverage,
} from "@suiming/runtime";
import { agentTurn } from "../../../packages/runtime/dist/harness/agent.js";
import { sampleWorkFiles, sampleWorkText } from "../../../packages/runtime/test/sample-work.js";
const root = process.env.SUIMING_NOTE_VALIDATION_ROOT;
assert.ok(root && !resolve(root).startsWith(resolve(".")), "请指定仓库外全新目录");
await mkdir(root);
for (const file of sampleWorkFiles()) {
	const path = join(root, file.path);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, file.bytes);
}
const p = await LocalProjectService.init({ checkoutPath: root, projectId: "source-note-update-validation" });
useEnvironmentProxy();
const telemetry = telemetryFromEnvironment(
	{
		...process.env,
		SUIMING_TELEMETRY_ENVIRONMENT: "validation",
		SUIMING_TELEMETRY_RELEASE: "source-note-update-20261015",
		SUIMING_TELEMETRY_CONTENT: "true",
	},
	{ entrypoint: "validation" },
);
try {
	const material = [1, 2]
		.map((i) => sampleWorkText(`outline/story/vol-0001/beat-000${i}.md`).replace(/^---\n[\s\S]*?\n---\n/u, ""))
		.join("\n");
	await p.ingestSource({ sourceId: "赤壁", name: "公开两节样例", original: new TextEncoder().encode(material) });
	for (const file of sampleWorkFiles().filter((f) => f.path.startsWith("outline/") || f.path.startsWith("world/"))) {
		const path = join(root, "source/赤壁", file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.bytes);
	}
	const notePath = "source/赤壁/notes/0001-0099.md";
	await mkdir(dirname(join(root, notePath)), { recursive: true });
	const old = `---\nspan: [0, ${[...material].length}]\nmaterial_sha256: ${createHash("sha256").update(material).digest("hex")}\n---\n黄盖带着十艘火船去曹营。\n`;
	await writeFile(join(root, notePath), old);
	const before = await p.checkoutCandidate();
	const target = new Map(
		before.artifacts
			.filter((a) => a.path !== notePath)
			.map((a) => [a.path, createHash("sha256").update(a.bytes).digest("hex")]),
	);
	const models = new ModelGateway(
		builtinModels({ credentials: new JsonFileCredentialStore() }),
		(await loadModelRoutingConfig()).config,
	);
	const h = new SuimingHarness({ project: p, models, telemetryContext: telemetry.context });
	const s = await h.createSession();
	p.queueInbox(
		s.id,
		`这是公开两节样例的隔离回归。已有 Source 赤壁 的抽取和材料笔记，请委派一个 source-extractor，span [0,${[...material].length})、beatRange {from:1,to:99}，根据原文核实并修正笔记中的火船数量，同时补齐识别船队的旗号。已有抽取保持不变，Target 和材料保持不变。子任务完成后核对覆盖并提交。不需要独立审稿。`,
	);
	const outcome = await h.turn(s.id, {}, (handle) => agentTurn(handle));
	const entities = p.loadExecutionEntities();
	const loops = [];
	for (const e of [...entities.sessions, ...entities.tasks]) {
		if (!e.checkpointRef) continue;
		const { loop } = await h.checkpoints.read((await p.readExecutionObject(e.checkpointRef.id)).bytes);
		loops.push({ id: e.id, calls: loop.calls, actions: loop.actions, opening: loop.messages[0] });
	}
	const candidate = await p.checkoutCandidate();
	const note = await readFile(join(root, notePath), "utf8");
	const result = {
		sessionId: s.id,
		failure: outcome.failure,
		usage: outcome.session.usage,
		tasks: entities.tasks,
		loops,
		note,
		coverage: sourceCoverage(candidate, "赤壁"),
	};
	await writeFile(`${root}.validation.json`, JSON.stringify(result, null, 2));
	assert.equal(outcome.failure, undefined);
	assert.deepEqual(
		new Map(
			candidate.artifacts
				.filter((a) => a.path !== notePath)
				.map((a) => [a.path, createHash("sha256").update(a.bytes).digest("hex")]),
		),
		target,
	);
	assert.deepEqual(await readdir(join(root, "source/赤壁/notes")), ["0001-0099.md"]);
	assert.match(note, /二十艘|二十只|20艘|20只/u);
	assert.match(note, /青龙牙旗/u);
	assert.notEqual(note, old);
	assert.deepEqual(result.coverage.gaps, []);
	assert.equal(entities.tasks.length, 1);
	assert.equal(entities.tasks[0]?.status, "completed");
	const child = loops.find((l) => l.id === entities.tasks[0]?.id);
	assert.ok(
		child?.actions.some(
			(a) =>
				["edit", "write"].includes(a.call.name) &&
				a.call.arguments.path === notePath &&
				a.message?.isError === false,
		),
	);
	assert.ok(
		loops.every((l) => l.actions.every((a) => !a.message?.isError)),
		"路径修正不应再触发拒绝",
	);
	console.log(
		JSON.stringify({
			sessionId: s.id,
			calls: outcome.session.usage.calls,
			costUsd: outcome.session.usage.costUsd,
			noteUpdated: true,
			errors: 0,
		}),
	);
} finally {
	p.close();
	await telemetry.shutdown();
}
