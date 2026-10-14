/** 隔离公共样例：真实连续写作、受控 Reviewer 故障、真实摘要落盘后的进程退出。 */
import assert from "node:assert/strict";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	JsonFileCredentialStore,
	loadModelRoutingConfig,
	ModelGateway,
	SuimingHarness,
	telemetryFromEnvironment,
	useEnvironmentProxy,
} from "@suiming/runtime";
import { agentTurn } from "../../../packages/runtime/dist/harness/agent.js";
import { runTaskLoop, type LoopCheckpoint } from "../../../packages/runtime/src/harness/loop.js";
import { emptyModelUsage } from "../../../packages/runtime/src/execution/model-usage.js";
import { withSampleProject } from "../../../packages/runtime/test/harness-fixtures.js";

useEnvironmentProxy();
const telemetry = telemetryFromEnvironment(
	{
		...process.env,
		SUIMING_TELEMETRY_ENVIRONMENT: "validation",
		SUIMING_TELEMETRY_RELEASE: "harness-alignment-20261015",
		SUIMING_TELEMETRY_CONTENT: "true",
	},
	{ entrypoint: "validation" },
);
const result: Record<string, unknown> = {};
try {
	const models = builtinModels({ credentials: new JsonFileCredentialStore() });
	const config = (await loadModelRoutingConfig()).config;
	const reviewer = fauxProvider({ provider: "alignment-controlled-reviewer" });
	reviewer.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "world/characters/黄盖.md" })),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "Controlled reviewer failure (non-retryable)" }),
		fauxAssistantMessage(
			fauxToolCall("submit_review", {
				verdict: "pass",
				summary: "合成故障恢复验收，不是文学评价",
				findings: [],
				uncovered: [],
				uncertainties: [],
			}),
		),
	]);
	models.setProvider(reviewer.provider);
	const gateway = new ModelGateway(models, {
		...config,
		profiles: { ...config.profiles, reviewer: { provider: reviewer.provider.id, model: reviewer.getModel().id } },
	});
	if (process.env.SUIMING_VALIDATION_ONLY !== "context")
		await withSampleProject(async (project, root) => {
			const harness = new SuimingHarness({ project, models: gateway, telemetryContext: telemetry.context });
			const session = await harness.createSession();
			console.log("creation session", session.id);
			const turn = async (text: string) => {
				project.queueInbox(session.id, text);
				const value = await harness.turn(session.id, {}, (handle) => agentTurn(handle));
				assert.equal(value.failure, undefined);
				console.log("turn", value.session.turn, value.session.usage);
				return value;
			};
			await turn(
				"按现有设计创作第一节正文，约 800 字，直接自行写作。长期偏好：人物做决定应表现具体代价，不用议论解释。请把这条偏好写回 Intent，检查后提交。此轮不用审稿，不写第二节。",
			);
			assert.ok((await readFile(join(root, "text/beat-0001.md"), "utf8")).length > 200);
			await turn(
				"调整长期偏好：保留具体代价，但不再要求完全避免议论，只允许关键转折有一句简短点明。更新 Intent；接着直接写第二节约 800 字，检查并提交。然后调用独立 review 审查设计；若审稿失败，本轮报告并结束，等我继续，不代替独立审稿。",
			);
			assert.ok((await readFile(join(root, "text/beat-0002.md"), "utf8")).length > 200);
			const intentPaths = await readdir(join(root, "intent"), { recursive: true });
			const intent = (
				await Promise.all(
					intentPaths
						.filter((path) => path.endsWith(".md"))
						.map((path) => readFile(join(root, "intent", path), "utf8")),
				)
			).join("\n");
			assert.match(intent, /关键转折/u);
			assert.doesNotMatch(intent, /不用议论解释/u);
			const failed = project.loadExecutionEntities().tasks.find((t) => t.kind === "reviewer");
			assert.equal(failed?.status, "failed");
			const final = await turn("审稿服务恢复了。沿原任务续做，已有正文保留，完成后检查并提交。");
			const tasks = project.loadExecutionEntities().tasks.filter((t) => t.kind === "reviewer");
			assert.equal(tasks.length, 1);
			assert.equal(tasks[0]?.id, failed?.id);
			assert.equal(tasks[0]?.status, "completed");
			const events = project.readSessionEvents(session.id);
			const activities = new Map<string, unknown>();
			for (const { event } of events)
				if (event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.action")
					activities.set(event.messageId, event.content);
			assert.ok([...activities.values()].every((a) => (a as { status: string }).status !== "running"));
			result.creation = {
				sessionId: session.id,
				taskId: failed?.id,
				usage: final.session.usage,
				revisions: (await project.history()).length,
				actions: activities.size,
			};
		});
	const bound = await gateway.bind("main");
	const model = { ...bound, model: { ...bound.model, contextWindow: 8000 } };
	let state: LoopCheckpoint = {
		schemaVersion: 2,
		loopId: "alignment-real-summary",
		sequence: 0,
		steeringSequence: 0,
		phase: "ready",
		messages: [{ role: "user", content: "任务：继续创作海边灯塔故事。", timestamp: 0 }],
		calls: [],
		actions: [],
		turns: 0,
		usage: emptyModelUsage(),
	};
	for (let n = 0; n < 16; n++)
		state.messages.push(
			{
				role: "user",
				content: `旧讨论 ${n}：${"主角曾要求悲剧结局，灯塔无人归来；暂未写进作品。".repeat(40)}`,
				timestamp: n,
			},
			fauxAssistantMessage("讨论已记录，尚未写入文件。"),
		);
	state.messages.push({
		role: "user",
		content: "最新改口：取消悲剧结局，让守塔人活着回来，但必须失去一艘船。请用三句话继续场景，不解释规则。",
		timestamp: 100,
	});
	const originals = structuredClone(state.messages);
	let crashed = false;
	await telemetry.context.startSpan({ name: "validation.context-recovery" }, async (span) => {
		const options = {
			model,
			loopId: state.loopId,
			systemPrompt: "你是小说作者，服从最新要求。",
			tools: [],
			budget: { maxTurns: 20 },
			telemetryContext: span,
			saveCheckpoint: async (next: LoopCheckpoint) => {
				state = structuredClone(next);
				if (!crashed && next.phase === "tools" && next.calls.at(-1)?.purpose === "compaction") {
					crashed = true;
					throw new Error("controlled crash after summary persisted");
				}
			},
		};
		await assert.rejects(runTaskLoop({ ...options, checkpoint: state }), /controlled crash/u);
		const first = state.calls.at(-1)?.id;
		const outcome = await runTaskLoop({ ...options, checkpoint: state });
		assert.equal(outcome.stop, "model_stopped");
		assert.equal(state.calls.filter((c) => c.id === first).length, 1);
		assert.ok(state.reduction);
		assert.deepEqual(state.messages.slice(0, originals.length), originals);
		result.context = {
			calls: state.calls.map((c) => ({ id: c.id, purpose: c.purpose ?? "execution", state: c.state })),
			usage: state.usage,
			summary: state.reduction.summary,
			reply: outcome.messages.at(-1),
			originalMessages: state.messages.length,
		};
	});
	if (process.env.SUIMING_VALIDATION_RESULT)
		await writeFile(process.env.SUIMING_VALIDATION_RESULT, JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} finally {
	await telemetry.shutdown();
}
