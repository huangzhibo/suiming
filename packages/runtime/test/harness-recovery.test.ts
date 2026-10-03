import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { ConfinedExecutionEnv } from "../src/harness/confined-env.js";
import { type LoopCheckpoint, runTaskLoop } from "../src/harness/loop.js";
import type { HarnessSession } from "../src/harness/suiming-harness.js";
import { fileTools } from "../src/harness/tools.js";
import type { ExecutionStateDelta, SessionRecord } from "../src/index.js";
import { ModelGateway } from "../src/model/model-gateway.js";

/** 这条执行命令写进去的 session 记录；命令没碰它就是 undefined。 */
function changedSession(delta: ExecutionStateDelta, sessionId: string): SessionRecord | undefined {
	return delta.changed.find((item) => item.type === "session" && item.record.id === sessionId)?.record as
		| SessionRecord
		| undefined;
}

async function fixture() {
	const provider = fauxProvider({ provider: "harness-recovery" });
	const models = createModels();
	models.setProvider(provider.provider);
	const profile = { provider: provider.provider.id, model: provider.getModel().id };
	const model = await new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }).bind("main");
	return { provider, model };
}

test("作者消息已存入 checkpoint 而消息发布失败时，恢复补齐同一条消息", async () => {
	const { provider, model } = await fixture();
	provider.setResponses([fauxAssistantMessage("完成")]);
	let checkpoint: LoopCheckpoint | undefined;
	const options = {
		model,
		systemPrompt: "test",
		prompt: "执行",
		tools: [],
		budget: { maxTurns: 3 },
		steering: () => [{ sequence: 1, text: "补充要求" }],
		async saveCheckpoint(value: LoopCheckpoint) {
			checkpoint = value;
		},
	};
	await assert.rejects(
		runTaskLoop({
			...options,
			onSteer() {
				throw new Error("event store unavailable");
			},
		}),
		/event store unavailable/,
	);
	assert.equal(checkpoint?.steeringSequence, 1);
	assert.equal(provider.state.callCount, 0);
	const messages: string[] = [];
	await runTaskLoop({
		...options,
		checkpoint,
		onSteer(text) {
			messages.push(text);
		},
	});
	assert.deepEqual(messages, ["补充要求"]);
	assert.equal(provider.state.callCount, 1);
});

test("进程在文件已改、结果未保存时退出：原动作 journal 续接，不重复相对修改", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-loop-recovery-"));
	try {
		await mkdir(join(root, "intent"));
		await writeFile(join(root, "intent/a.md"), "A");
		const { provider, model } = await fixture();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "intent/a.md", oldText: "A", newText: "AA" })),
			fauxAssistantMessage("完成"),
		]);
		let checkpoint: LoopCheckpoint | undefined;
		let crash = true;
		const options = {
			model,
			loopId: "loop-stable",
			tools: fileTools(new ConfinedExecutionEnv({ rootPath: root, policy: "write" }), "write"),
			systemPrompt: "修改",
			prompt: "执行",
			budget: { maxTurns: 3 },
			saveCheckpoint: async (next: LoopCheckpoint) => {
				if (crash && next.actions.some((action) => action.state === "result_ready"))
					throw new Error("process exited before result persistence");
				checkpoint = structuredClone(next);
			},
		};
		await assert.rejects(runTaskLoop(options), /process exited/u);
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "AA");
		assert.equal(checkpoint?.actions[0]?.state, "effect_pending");
		const actionId = checkpoint?.actions[0]?.id;
		crash = false;
		assert.ok(checkpoint);
		const result = await runTaskLoop({ ...options, checkpoint });
		assert.equal(result.stop, "model_stopped");
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "AA");
		assert.equal(checkpoint?.actions[0]?.id, actionId);
		assert.equal(provider.state.callCount, 2);
		assert.equal(result.messages.filter((message) => message.role === "toolResult").length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("准备写入之后作者改了同一个文件：写冲突作为工具错误交给模型，turn 继续，作者的内容不被覆盖", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-loop-conflict-"));
	try {
		await mkdir(join(root, "intent"));
		await writeFile(join(root, "intent/a.md"), "A");
		const { provider, model } = await fixture();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "intent/a.md", oldText: "A", newText: "AA" })),
			fauxAssistantMessage("完成"),
		]);
		let authorEdited = false;
		const result = await runTaskLoop({
			model,
			tools: fileTools(new ConfinedExecutionEnv({ rootPath: root, policy: "write" }), "write"),
			systemPrompt: "修改",
			prompt: "执行",
			budget: { maxTurns: 3 },
			saveCheckpoint: async (next: LoopCheckpoint) => {
				// 动作已落 journal、还没落盘时，作者在编辑器里存了同一个文件。
				if (!authorEdited && next.actions.some((action) => action.state === "effect_pending")) {
					authorEdited = true;
					await writeFile(join(root, "intent/a.md"), "作者改的");
				}
			},
		});
		assert.equal(result.stop, "model_stopped");
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "作者改的");
		assert.equal(provider.state.callCount, 2);
		const toolResult = result.messages.find((message) => message.role === "toolResult");
		assert.equal(toolResult?.isError, true);
		const text = toolResult?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		assert.match(text ?? "", /file_write_conflict/u);
		assert.match(text ?? "", /重新读取/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("动作已落 journal 时进程退出、重启前作者改了同一个文件：续接报写冲突给模型，不会每个 turn 撞同一个冲突", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-loop-conflict-resume-"));
	try {
		await mkdir(join(root, "intent"));
		await writeFile(join(root, "intent/a.md"), "A");
		const { provider, model } = await fixture();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", { path: "intent/a.md", oldText: "A", newText: "AA" })),
			fauxAssistantMessage("完成"),
		]);
		let checkpoint: LoopCheckpoint | undefined;
		let crash = true;
		const options = {
			model,
			loopId: "loop-conflict",
			tools: fileTools(new ConfinedExecutionEnv({ rootPath: root, policy: "write" }), "write"),
			systemPrompt: "修改",
			prompt: "执行",
			budget: { maxTurns: 3 },
			saveCheckpoint: async (next: LoopCheckpoint) => {
				checkpoint = structuredClone(next);
				if (crash && next.actions.some((action) => action.state === "effect_pending"))
					throw new Error("process exited after journal");
			},
		};
		await assert.rejects(runTaskLoop(options), /process exited/u);
		assert.equal(checkpoint?.actions[0]?.state, "effect_pending");
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "A");
		await writeFile(join(root, "intent/a.md"), "作者改的");
		crash = false;
		assert.ok(checkpoint);
		const result = await runTaskLoop({ ...options, checkpoint });
		assert.equal(result.stop, "model_stopped");
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "作者改的");
		assert.equal(provider.state.callCount, 2);
		const toolResult = result.messages.find((message) => message.role === "toolResult");
		assert.equal(toolResult?.isError, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("已保存的终止结果可在新闭包中交付，不重复执行提交工具", async () => {
	const { provider, model } = await fixture();
	provider.setResponses([fauxAssistantMessage(fauxToolCall("submit", {}))]);
	let checkpoint: LoopCheckpoint | undefined;
	let executions = 0;
	const options = {
		model,
		loopId: "loop-result",
		systemPrompt: "提交",
		prompt: "执行",
		budget: { maxTurns: 3 },
		tools: [
			{
				name: "submit",
				description: "提交",
				replay: "read" as const,
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text" as const, text: "accepted" }], terminate: true };
				},
			},
		],
		captureSubmission: () => ({ reportId: "report-1", content: "完整交付" }),
		saveCheckpoint: async (next: LoopCheckpoint) => {
			checkpoint = structuredClone(next);
		},
		onToolCall: () => {
			throw new Error("notification failed");
		},
	};
	await assert.rejects(runTaskLoop(options), /notification failed/u);
	assert.equal(checkpoint?.actions[0]?.state, "result_ready");
	assert.ok(checkpoint);
	const result = await runTaskLoop({
		...options,
		checkpoint,
		onToolCall: () => {},
		captureSubmission: () => undefined,
	});
	assert.deepEqual(result.submission, { reportId: "report-1", content: "完整交付" });
	assert.equal(executions, 1);
	assert.equal(provider.state.callCount, 1);
});

test("未知模型结果默认停下；显式重试保留旧调用记录与同一 loop", async () => {
	const { provider, model } = await fixture();
	provider.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("retry")]);
	let checkpoint: LoopCheckpoint | undefined;
	let crash = true;
	const options = {
		model,
		loopId: "loop-unknown",
		systemPrompt: "执行",
		prompt: "执行",
		tools: [],
		budget: { maxTurns: 3 },
		saveCheckpoint: async (next: LoopCheckpoint) => {
			if (crash && next.calls.some((call) => call.state === "received"))
				throw new Error("process exited before response persistence");
			checkpoint = structuredClone(next);
		},
	};
	await assert.rejects(runTaskLoop(options), /process exited/u);
	assert.ok(checkpoint);
	crash = false;
	await assert.rejects(runTaskLoop({ ...options, checkpoint }), { code: "model_call_unknown" });
	assert.equal(provider.state.callCount, 1);
	assert.ok(checkpoint);
	const oldCallId = checkpoint.calls[0]?.id;
	const result = await runTaskLoop({ ...options, checkpoint, retryUnknownModelCall: true });
	assert.equal(result.stop, "model_stopped");
	assert.equal(checkpoint?.loopId, "loop-unknown");
	assert.equal(checkpoint?.calls[0]?.state, "unknown");
	assert.equal(checkpoint?.calls[0]?.id, oldCallId);
	assert.notEqual(checkpoint?.calls[1]?.id, oldCallId);
	assert.equal(provider.state.callCount, 2);
});

test("换绑只在没有未决副作用的边界发生；停在动作中间时报 binding_mismatch", async () => {
	const { provider, model } = await fixture();
	provider.setResponses([fauxAssistantMessage(fauxToolCall("slow", {})), fauxAssistantMessage("完成")]);
	let checkpoint: LoopCheckpoint | undefined;
	let crash = true;
	const tools = (label: string) => [
		{
			name: "slow",
			description: label,
			replay: "read" as const,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "done" }] }),
		},
	];
	const options = {
		model,
		loopId: "loop-binding",
		systemPrompt: "执行",
		prompt: "执行",
		budget: { maxTurns: 5 },
		saveCheckpoint: async (next: LoopCheckpoint) => {
			if (crash && next.actions.some((action) => action.state === "effect_pending"))
				throw new Error("process exited during the action");
			checkpoint = structuredClone(next);
		},
	};
	await assert.rejects(runTaskLoop({ ...options, tools: tools("v1") }), /process exited/u);
	crash = false;
	assert.ok(checkpoint);
	// 工具声明变了 = 绑定变了；动作还没确认，不能带着新绑定续。
	await assert.rejects(runTaskLoop({ ...options, checkpoint, tools: tools("v2") }), { code: "binding_mismatch" });
	const result = await runTaskLoop({ ...options, checkpoint, tools: tools("v1") });
	assert.equal(result.stop, "model_stopped");
	assert.ok(checkpoint);
	const settled = checkpoint;
	// 停下之后没有未决副作用：下一次可以带新声明续跑。
	provider.setResponses([fauxAssistantMessage("新声明下继续")]);
	const rebound = await runTaskLoop({
		...options,
		checkpoint: settled,
		tools: tools("v2"),
		steering: () => [{ sequence: 1, text: "再说一句" }],
	});
	assert.equal(rebound.stop, "model_stopped");
	assert.equal(provider.state.callCount, 3);
});

test("子任务完成后父 checkpoint 确认丢失：重启续跑只交还保存的结果，同一 action 不创建第二个子任务", async (t) => {
	const { LocalProjectService, materializeOpenStoryDirectorySnapshot, SuimingHarness } = await import(
		"../src/index.js"
	);
	const { sampleWorkFiles } = await import("./sample-work.js");
	const { submitTool } = await import("../src/harness/tools.js");
	const root = await mkdtemp(join(tmpdir(), "suiming-child-handoff-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-handoff" });
	try {
		const provider = fauxProvider({ provider: "handoff" });
		const models = createModels();
		models.setProvider(provider.provider);
		const profile = { provider: provider.provider.id, model: provider.getModel().id };
		const harness = new SuimingHarness({
			project,
			models: new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }),
		});
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", {})),
			fauxAssistantMessage(fauxToolCall("submit_child", { report: "已校验的完整报告" })),
			async (context) => {
				assert.ok(JSON.stringify(context.messages).includes("已校验的完整报告"));
				return fauxAssistantMessage("已采用报告");
			},
		]);
		const session = await harness.createSession();
		const apply = project.applyExecutionDelta.bind(project);
		let crash = true;
		t.mock.method(project, "applyExecutionDelta", (delta: ExecutionStateDelta) => {
			const state = project.loadExecutionState();
			const child = state.tasks.find((task) => task.parent !== undefined);
			const record = changedSession(delta, session.id);
			const persisted = state.sessions.find((item) => item.id === session.id);
			if (
				crash &&
				child?.status === "completed" &&
				record !== undefined &&
				record.checkpointRef?.id !== persisted?.checkpointRef?.id
			)
				throw new Error("lost parent checkpoint acknowledgement");
			apply(delta);
		});
		const body = (handle: HarnessSession) =>
			handle.runRoot({
				systemPrompt: "自主决定是否委派",
				tools: (parent) => {
					const delegate = async (actionId: string) => {
						let report: unknown;
						const child = await handle.executeChild(parent, actionId, {
							kind: "reviewer",
							profileId: "reviewer",
							policy: "read",
							systemPrompt: "独立审查",
							prompt: "审查",
							maxTurns: 3,
							tools: () => [
								submitTool({
									name: "submit_child",
									description: "交付",
									parameters: Type.Object({ report: Type.String() }),
									onSubmit: (params) => {
										report = params;
										return params.report;
									},
								}),
							],
							result: () => report,
							resultMediaType: "application/json",
						});
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										taskId: child.taskId,
										resultObjectId: child.resultObjectId,
										result: child.result,
									}),
								},
							],
						};
					};
					return [
						{
							name: "delegate",
							description: "独立审查",
							parameters: Type.Object({}),
							replay: "reconcile" as const,
							execute: delegate,
							reconcile: delegate,
						},
					];
				},
			});
		project.queueInbox(session.id, "委派并回收报告");
		await assert.rejects(harness.turn(session.id, {}, body), /lost parent checkpoint/u);
		let state = project.loadExecutionState();
		const childId = state.tasks.find((task) => task.parent !== undefined)?.id;
		assert.ok(childId);
		assert.equal(state.tasks.find((task) => task.id === childId)?.status, "completed");
		assert.equal(state.sessions[0]?.status, "running", "确认丢失的实例不能再记账，留给重开收敛");
		crash = false;
		project.createExecutionState().recoverUnfinished("test:crash", { holderAlive: () => false });
		const outcome = await harness.turn(session.id, {}, body);
		assert.equal(outcome.failure, undefined);
		assert.equal(outcome.value?.reply, "已采用报告");
		state = project.loadExecutionState();
		assert.equal(state.tasks.length, 1);
		assert.equal(state.tasks[0]?.id, childId);
		assert.equal(state.sessions[0]?.status, "idle");
		assert.equal(provider.state.callCount, 3);
	} finally {
		project.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("同一 turn 两次阶段提交；第一次 revision 已确认但动作结果丢失时，重启续接不重复提交", async (t) => {
	const { LocalProjectService, materializeOpenStoryDirectorySnapshot, SuimingHarness } = await import(
		"../src/index.js"
	);
	const { agentTurn } = await import("../src/harness/agent.js");
	const { sampleWorkFiles } = await import("./sample-work.js");
	const root = await mkdtemp(join(tmpdir(), "suiming-stage-commit-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-stages" });
	try {
		const provider = fauxProvider({ provider: "stages" });
		const models = createModels();
		models.setProvider(provider.provider);
		const profile = { provider: provider.provider.id, model: provider.getModel().id };
		const harness = new SuimingHarness({
			project,
			models: new ModelGateway(models, { profiles: { main: profile, reviewer: profile } }),
		});
		const original = project.project().headRevisionId;
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "intent/计谋的代价.md", content: "主角必须为真相承担代价。" }),
			),
			fauxAssistantMessage(fauxToolCall("commit", { summary: "第一阶段" })),
			fauxAssistantMessage(
				fauxToolCall("write", {
					path: "world/characters/黄盖.md",
					content: "黄盖相信证据，愿意为自己的选择承担后果。",
				}),
			),
			fauxAssistantMessage(fauxToolCall("commit", { summary: "第二阶段" })),
			fauxAssistantMessage("已完成两阶段修改"),
		]);
		const session = await harness.createSession();
		const apply = project.applyExecutionDelta.bind(project);
		let crash = true;
		t.mock.method(project, "applyExecutionDelta", (delta: ExecutionStateDelta) => {
			const record = changedSession(delta, session.id);
			const persisted = project.loadExecutionState().sessions.find((item) => item.id === session.id);
			if (
				crash &&
				project.project().headRevisionId !== original &&
				record !== undefined &&
				record.checkpointRef?.id !== persisted?.checkpointRef?.id
			)
				throw new Error("exit after revision commit");
			apply(delta);
		});
		project.queueInbox(session.id, "分阶段修改并提交");
		await assert.rejects(
			harness.turn(session.id, {}, (handle) => agentTurn(handle)),
			/exit after revision commit/u,
		);
		assert.equal((await project.history()).length, 2);
		crash = false;
		project.createExecutionState().recoverUnfinished("test:restart", { holderAlive: () => false });
		const outcome = await harness.turn(session.id, {}, (handle) => agentTurn(handle));
		assert.equal(outcome.failure, undefined);
		assert.equal((await project.history()).length, 3, "只有两次有意提交");
		const state = project.loadExecutionState();
		assert.equal(state.tasks.length, 0);
		assert.equal(state.sessions[0]?.baseRevisionId, project.project().headRevisionId);
		assert.equal(state.sessions[0]?.status, "idle");
		assert.equal(provider.state.callCount, 5);
	} finally {
		project.close();
		await rm(root, { recursive: true, force: true });
	}
});
