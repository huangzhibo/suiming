/** 公开三国样例的隔离副本；prepare、stop、resume 分进程运行，结果只留仓库外。 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	JsonFileCredentialStore,
	loadModelRoutingConfig,
	LocalProjectService,
	ModelGateway,
	SuimingHarness,
	sourceCoverage,
	telemetryFromEnvironment,
	useEnvironmentProxy,
} from "@suiming/runtime";
import { agentTurn } from "../../../packages/runtime/dist/harness/agent.js";
import type { LoopCheckpoint } from "../../../packages/runtime/dist/harness/loop.js";
import { renderSourceRange, formatSourceCheck } from "../../../packages/runtime/dist/harness/source-context.js";

const root = process.env.SUIMING_VALIDATION_ROOT;
assert.ok(root && !resolve(root).startsWith(resolve(".")), "SUIMING_VALIDATION_ROOT 必须在仓库外");
const mode = process.argv[2];
const sourceId = "sanguo-0001-0050";
const source = join(root, "source", sourceId);
const metaPath = `${root}.validation.json`;

if (mode === "prepare") {
	// cp 不覆盖已有副本，真实作品不作为目标。
	await mkdir(root);
	for (const entry of await readdir("examples/sanguo"))
		await cp(join("examples/sanguo", entry), join(root, entry), {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	for (const dir of ["outline", "world"]) await cp(join(root, dir), join(source, dir), { recursive: true });
	const late = join(source, "outline/story/vol-0009/beat-0440.md");
	await writeFile(
		late,
		(await readFile(late, "utf8")).replace(/  beat: \[[^\n]+\]/u, "  beat: [beat-0436, beat-0439]"),
	);
	const note = join(source, "notes/0001-0099.md");
	await writeFile(note, (await readFile(note, "utf8")).replace("span: [0, 48181]", "span: [0, 47500]"));
	await writeFile(
		join(source, "notes/stale-gap.md"),
		`---\nspan: [47500, 48181]\nmaterial_sha256: ${"f".repeat(64)}\n---\n旧材料的笔记，不应抵消当前缺口。\n`,
	);
	const material = await readFile(join(source, "material.txt"), "utf8");
	const position = (heading: string) => {
		const at = material.indexOf(heading);
		assert.ok(at >= 0);
		return [...material.slice(0, at)].length;
	};
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "large-source-validation" });
	try {
		const candidate = await project.checkoutCandidate();
		const coverage = sourceCoverage(candidate, sourceId);
		assert.deepEqual(coverage.gaps, [[47500, 48181]]);
		const ranges = [
			{ span: [position("第二十五回："), position("第二十六回：")], beatRange: { from: 223, to: 224 } },
			{ span: [position("第五十回："), [...material].length], beatRange: { from: 439, to: 440 } },
		];
		const meta = {
			sourceId,
			ranges,
			coverage,
			check: formatSourceCheck(candidate, sourceId),
			projectedBytes: ranges.map((r) => Buffer.byteLength(renderSourceRange(candidate, sourceId, r.beatRange))),
			targetDigests: Object.fromEntries(
				candidate.artifacts
					.filter((a) => !a.path.startsWith("source/"))
					.map((a) => [a.path, createHash("sha256").update(a.bytes).digest("hex")]),
			),
		};
		assert.match(meta.check, /^PASSED/u);
		await writeFile(metaPath, JSON.stringify(meta, null, 2));
		console.log(JSON.stringify({ root, ranges, gaps: coverage.gaps, projectedBytes: meta.projectedBytes }));
	} finally {
		project.close();
	}
} else {
	assert.ok(mode === "stop" || mode === "resume" || mode === "expand" || mode === "inspect");
	const meta = JSON.parse(await readFile(metaPath, "utf8"));
	const project = await LocalProjectService.open(root);
	useEnvironmentProxy();
	const telemetry = telemetryFromEnvironment(
		{
			...process.env,
			SUIMING_TELEMETRY_ENVIRONMENT: "validation",
			SUIMING_TELEMETRY_RELEASE: "large-source-20261015",
			SUIMING_TELEMETRY_CONTENT: "true",
		},
		{ entrypoint: "validation" },
	);
	try {
		const config = (await loadModelRoutingConfig()).config;
		const gateway = new ModelGateway(builtinModels({ credentials: new JsonFileCredentialStore() }), config);
		const harness = new SuimingHarness({ project, models: gateway, telemetryContext: telemetry.context });
		if (mode === "stop") {
			const session = await harness.createSession();
			meta.sessionId = session.id;
			await writeFile(metaPath, JSON.stringify(meta, null, 2));
			project.queueInbox(
				session.id,
				`这是隔离验证副本。只处理 Source ${sourceId}，本作 Target 保持不变。已有 9 卷 231 个情节，未要求重抽全书。请完成：先 source_coverage 核对当前材料的阅读缺口，委派 source-reader 回读缺口并写自己的笔记，不使用旧 sha 笔记冒充覆盖；然后按以下两个范围委派 source-extractor 补全，两段都要核对关羽受曹恩与华容放曹的跨卷因果、期待生命周期和人物身份，主动读取范围外的真实依据。范围：${JSON.stringify(meta.ranges)}。已有后段缺少跨卷关联，请自行根据原文和全书抽取恢复该连的 refs.beat，不能凭编号或记忆猜。范围外必要修正由根 Agent 统一处理；最后 check 和 source_coverage 对账，通过后提交，说明已验证范围。本轮不跑整本独立审稿，也不扩大至全部 231 节。`,
			);
		} else if (mode === "resume") {
			project.queueInbox(
				meta.sessionId,
				"继续刚才的 Source 补全。沿原来的被打断任务 resume_task，保留已完成工作，不重复创建同一工作任务；完成跨卷关联、覆盖对账和检查后提交。Target 保持不变，不扩大范围。",
			);
		}
		if (mode === "expand") {
			const range = { from: 401, to: 499 };
			const candidate = await project.checkoutCandidate();
			const projected = renderSourceRange(candidate, sourceId, range);
			meta.expandedInput = {
				span: [197346, 249272],
				beatRange: range,
				projectedBytes: Buffer.byteLength(projected),
				deferredFiles: (projected.match(/按需读取：/gu) ?? []).length,
			};
			project.queueInbox(
				meta.sessionId,
				`两个小范围已复验，现在扩大到原分段中的完整末段。只处理同一 Source ${sourceId}，原文 [197346,249272)，beatRange {from:401,to:499}，当前实际 41 节。委派一个带此范围的 source-extractor 逐段回读原文并完成本段补全；预载提示按需读取的文件仍要读取。核对跨卷因果、未解期待的回应、人物异名与物品归属；无需重抽全书或润色已经准确的段落，有具体遗漏或错误才改。号段外必要修正交回根 Agent 核实处理。完成后由根 Agent 检查 Source、覆盖对账并提交，明确实际修改和剩余不确定处；不跑整本独立审稿，不改 Target。`,
			);
		}

		if (mode !== "inspect") {
			const abort = new AbortController();
			let stopped = false;
			const outcome = await harness.turn(
				meta.sessionId,
				{
					signal: abort.signal,
					onEvent: ({ event }) => {
						if (event.type !== "ACTIVITY_SNAPSHOT" || event.activityType !== "suiming.action") return;
						const content = event.content as { label: string; status: string };
						if (content.status !== "running")
							console.log(
								JSON.stringify({ time: new Date().toISOString(), task: event.subagentRunId, ...content }),
							);
						if (
							mode === "stop" &&
							!stopped &&
							event.subagentRunId &&
							content.status === "completed" &&
							(content.label === "edit" || content.label === "write") &&
							project
								.loadExecutionEntities()
								.tasks.some((t) => t.id === event.subagentRunId && t.kind === "source-extractor")
						) {
							stopped = true;
							meta.interruptedTaskId = event.subagentRunId;
							abort.abort("验证：子任务写入确认后停止，再由新进程续做");
						}
					},
				},
				(handle) => agentTurn(handle),
			);
			meta[mode] = {
				failure: outcome.failure,
				usage: outcome.session.usage,
				stopped,
				tasks: project.loadExecutionEntities().tasks,
			};
			console.log("TURN", JSON.stringify(meta[mode]));
			assert.equal(outcome.failure, undefined);
			if (mode === "stop") assert.equal(stopped, true);
		}
		const candidate = await project.checkoutCandidate();
		meta.final = {
			coverage: sourceCoverage(candidate, sourceId),
			check: formatSourceCheck(candidate, sourceId),
			revisions: (await project.history()).length,
			late: await readFile(join(source, "outline/story/vol-0009/beat-0440.md"), "utf8"),
		};
		assert.deepEqual(
			Object.fromEntries(
				candidate.artifacts
					.filter((a) => !a.path.startsWith("source/"))
					.map((a) => [a.path, createHash("sha256").update(a.bytes).digest("hex")]),
			),
			meta.targetDigests,
			"Target 文件集或内容改变",
		);
		const entities = project.loadExecutionEntities();
		meta.loops = [];
		for (const entity of [...entities.sessions, ...entities.tasks]) {
			if (!entity.checkpointRef) continue;
			const object = await project.readExecutionObject(entity.checkpointRef.id);
			const checkpoint = (await harness.checkpoints.read(object.bytes)) as {
				loop: LoopCheckpoint;
			};
			meta.loops.push({
				id: entity.id,
				calls: checkpoint.loop.calls,
				actions: checkpoint.loop.actions,
				opening: checkpoint.loop.messages[0],
			});
		}
		if (mode === "resume" || mode === "expand") {
			assert.deepEqual(meta.final.coverage.gaps, []);
			assert.match(meta.final.check, /^PASSED/u);
			assert.match(meta.final.late.split("---")[1] ?? "", /beat-02\d\d/u, "华容放曹应有早期跨卷依据");
			assert.equal(
				project.loadExecutionEntities().tasks.find((t) => t.id === meta.interruptedTaskId)?.status,
				"completed",
			);
		}
		await writeFile(metaPath, JSON.stringify(meta, null, 2));
		console.log(
			"FINAL",
			JSON.stringify({ gaps: meta.final.coverage.gaps, revisions: meta.final.revisions, sessionId: meta.sessionId }),
		);
	} finally {
		project.close();
		await telemetry.shutdown();
	}
}
