/** 真实根模型 + 可控 Reviewer 故障；先构建，再用 --env-file=.env --import tsx 运行。 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
import { withSampleProject } from "../../../packages/runtime/test/harness-fixtures.js";

useEnvironmentProxy();
const telemetry = telemetryFromEnvironment(
	{
		...process.env,
		SUIMING_TELEMETRY_ENVIRONMENT: "validation",
		SUIMING_TELEMETRY_RELEASE: "continuous-recovery-fix",
		SUIMING_TELEMETRY_CONTENT: "true",
	},
	{ entrypoint: "validation" },
);
try {
	await withSampleProject(async (project) => {
		const reviewer = fauxProvider({ provider: "controlled-reviewer-failure" });
		reviewer.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "world/characters/黄盖.md" })),
			...Array.from({ length: 6 }, () => ({
				...fauxAssistantMessage(""),
				stopReason: "error" as const,
				errorMessage: "Synthetic reviewer service unavailable",
			})),
			(context) => {
				assert.ok(context.messages.some((message) => message.role === "toolResult" && message.toolName === "read"));
				return fauxAssistantMessage(
					fauxToolCall("submit_review", {
						verdict: "pass",
						summary: "故障恢复机制验收的合成审稿，不是文学评价。",
						findings: [],
						uncovered: [],
						uncertainties: [],
					}),
				);
			},
		]);
		const models = builtinModels({ credentials: new JsonFileCredentialStore() });
		models.setProvider(reviewer.provider);
		const config = (await loadModelRoutingConfig()).config;
		const gateway = new ModelGateway(models, {
			...config,
			profiles: { ...config.profiles, reviewer: { provider: reviewer.provider.id, model: reviewer.getModel().id } },
		});
		const harness = new SuimingHarness({ project, models: gateway, telemetryContext: telemetry.context });
		const session = await harness.createSession();
		console.log("validation session", session.id);
		const turn = async (text: string) => {
			project.queueInbox(session.id, text);
			const result = await harness.turn(session.id, {}, (handle) => agentTurn(handle));
			assert.equal(result.failure, undefined);
			return result;
		};
		const first = await turn(
			"请调用独立 review 审查当前设计。若审稿服务暂时失败，本轮报告原因并结束，等我说继续；不要自己替代独立审稿。成功后检查并提交一次。不要修改设计或正文。",
		);
		const failed = project.loadExecutionEntities().tasks;
		assert.equal(failed.length, 1);
		assert.equal(failed[0]?.status, "failed");
		const second = await turn("审稿服务已恢复，继续完成刚才未完成的任务，保留已有工作，最后检查并提交一次。");
		const tasks = project.loadExecutionEntities().tasks;
		assert.equal(tasks.length, 1, "真实主模型应续做而非重建审稿");
		assert.equal(tasks[0]?.id, failed[0]?.id);
		assert.equal(tasks[0]?.status, "completed");
		const history = await project.history();
		assert.equal(history.length, 2);
		const summary = {
			sessionId: session.id,
			taskId: tasks[0]?.id,
			rootModel: second.session.model,
			usage: second.session.usage,
			reviewer: "controlled synthetic failure and result",
			tasks: tasks.length,
			revisions: history.length,
			replies: [first.value?.reply, second.value?.reply],
		};
		if (process.env.SUIMING_VALIDATION_RESULT)
			await writeFile(process.env.SUIMING_VALIDATION_RESULT, JSON.stringify(summary, null, 2));
		console.log(JSON.stringify(summary, null, 2));
	});
} finally {
	await telemetry.shutdown();
}
