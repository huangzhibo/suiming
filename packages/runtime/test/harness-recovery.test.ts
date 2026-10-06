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

test("进程在动作执行时退出：续跑不重做它，补「执行时被打断」；同一批还没开始的补「没有执行」，由模型决定", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-loop-recovery-"));
	try {
		await mkdir(join(root, "intent"));
		await writeFile(join(root, "intent/a.md"), "A");
		await writeFile(join(root, "intent/b.md"), "B");
		const { provider, model } = await fixture();
		provider.setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: "intent/a.md", oldText: "A", newText: "A2" }),
				fauxToolCall("edit", { path: "intent/b.md", oldText: "B", newText: "B2" }),
			]),
			async (context) => {
				const texts = context.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
				assert.equal(texts.length, 2);
				assert.match(texts[0] ?? "", /执行时被打断/u);
				assert.match(texts[1] ?? "", /没有执行/u);
				return fauxAssistantMessage("先读一下再说");
			},
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
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "A2");
		assert.deepEqual(
			checkpoint?.actions.map((action) => action.state),
			["effect_pending", "planned"],
		);
		crash = false;
		assert.ok(checkpoint);
		const result = await runTaskLoop({ ...options, checkpoint });
		assert.equal(result.stop, "model_stopped");
		assert.equal(await readFile(join(root, "intent/a.md"), "utf8"), "A2", "执行到一半的动作不再执行第二次");
		assert.equal(await readFile(join(root, "intent/b.md"), "utf8"), "B", "没开始的动作不替模型补做");
		assert.equal(provider.state.callCount, 2);
		assert.ok(result.messages.filter((message) => message.role === "toolResult").every((message) => message.isError));
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
		const env = new ConfinedExecutionEnv({ rootPath: root, policy: "write" });
		const apply = env.applyMutation.bind(env);
		let authorEdited = false;
		// 算好要写的内容之后、落盘之前，作者在编辑器里存了同一个文件。
		env.applyMutation = async (mutation, signal) => {
			if (!authorEdited) {
				authorEdited = true;
				await writeFile(join(root, "intent/a.md"), "作者改的");
			}
			return apply(mutation, signal);
		};
		const result = await runTaskLoop({
			model,
			tools: fileTools(env, "write"),
			systemPrompt: "修改",
			prompt: "执行",
			budget: { maxTurns: 3 },
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

test("模型回复没收到就退出：续跑作废那次请求，用当前消息重新组装（带上新的话），不停下等作者", async () => {
	const { provider, model } = await fixture();
	provider.setResponses([
		fauxAssistantMessage("first"),
		async (context) => {
			assert.ok(JSON.stringify(context.messages).includes("补一句"));
			return fauxAssistantMessage("retry");
		},
	]);
	let checkpoint: LoopCheckpoint | undefined;
	let crash = true;
	let inbox: { sequence: number; text: string }[] = [];
	const options = {
		model,
		loopId: "loop-unknown",
		systemPrompt: "执行",
		prompt: "执行",
		tools: [],
		budget: { maxTurns: 3 },
		steering: () => inbox,
		saveCheckpoint: async (next: LoopCheckpoint) => {
			if (crash && next.calls.some((call) => call.state === "received"))
				throw new Error("process exited before response persistence");
			checkpoint = structuredClone(next);
		},
	};
	await assert.rejects(runTaskLoop(options), /process exited/u);
	assert.equal(checkpoint?.calls[0]?.state, "effect_pending");
	const oldCallId = checkpoint?.calls[0]?.id;
	crash = false;
	inbox = [{ sequence: 1, text: "补一句" }];
	assert.ok(checkpoint);
	const result = await runTaskLoop({ ...options, checkpoint });
	assert.equal(result.stop, "model_stopped");
	assert.equal(checkpoint?.calls[0]?.id, oldCallId);
	assert.equal(checkpoint?.calls[0]?.state, "unknown", "可能已计费的那次请求留下记录");
	assert.equal(checkpoint?.calls[1]?.state, "received");
	assert.equal(provider.state.callCount, 2);
});

test("停在一批动作中间时工具面变了：照样续上，被打断的动作补结果，新请求用新的工具声明", async () => {
	const { provider, model } = await fixture();
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("slow", {})),
		async (context) => {
			// faux 拿到的是折好的 transcript，工具声明在开头那条 system 消息里。
			assert.ok(JSON.stringify(context).includes("v2"));
			assert.ok(!JSON.stringify(context).includes("v1"));
			return fauxAssistantMessage("完成");
		},
	]);
	let checkpoint: LoopCheckpoint | undefined;
	let crash = true;
	let executions = 0;
	const tools = (label: string) => [
		{
			name: "slow",
			description: label,
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				return { content: [{ type: "text" as const, text: "done" }] };
			},
		},
	];
	const options = {
		model,
		loopId: "loop-binding",
		systemPrompt: "执行",
		prompt: "执行",
		budget: { maxTurns: 5 },
		saveCheckpoint: async (next: LoopCheckpoint) => {
			checkpoint = structuredClone(next);
			if (crash && next.actions.some((action) => action.state === "effect_pending"))
				throw new Error("process exited during the action");
		},
	};
	await assert.rejects(runTaskLoop({ ...options, tools: tools("v1") }), /process exited/u);
	assert.equal(checkpoint?.actions[0]?.state, "effect_pending");
	crash = false;
	assert.ok(checkpoint);
	const result = await runTaskLoop({ ...options, checkpoint, tools: tools("v2") });
	assert.equal(result.stop, "model_stopped");
	assert.equal(executions, 0, "被打断的动作不重做");
	assert.equal(provider.state.callCount, 2);
});

test("子任务完成后父 checkpoint 确认丢失：父 Agent 看到子任务其实已做完，resume_task 交回保存的结果，不建第二个子任务", async (t) => {
	const { LocalProjectService, materializeOpenStoryDirectorySnapshot, SuimingHarness } = await import(
		"../src/index.js"
	);
	const { agentTurn } = await import("../src/harness/agent.js");
	const { sampleWorkFiles } = await import("./sample-work.js");
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
		const textOf = (context: { messages: unknown[] }) => JSON.stringify(context.messages);
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", { goal: "核对黄盖的人物档", profile: "main" })),
			fauxAssistantMessage(fauxToolCall("submit_task", { summary: "已校验的完整报告" })),
			async (context) => {
				const taskId = /子任务 (task_[0-9a-f-]+)/u.exec(textOf(context))?.[1];
				assert.ok(textOf(context).includes("其实已经做完了"));
				assert.ok(taskId);
				return fauxAssistantMessage(fauxToolCall("resume_task", { taskId }));
			},
			async (context) => {
				assert.ok(textOf(context).includes("已校验的完整报告"));
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
		project.queueInbox(session.id, "委派并回收报告");
		await assert.rejects(
			harness.turn(session.id, {}, (handle: HarnessSession) => agentTurn(handle)),
			/lost parent checkpoint/u,
		);
		let state = project.loadExecutionState();
		const childId = state.tasks.find((task) => task.parent !== undefined)?.id;
		assert.ok(childId);
		assert.equal(state.tasks.find((task) => task.id === childId)?.status, "completed");
		assert.equal(state.sessions[0]?.status, "running", "确认丢失的实例不能再记账，留给重开收敛");
		crash = false;
		project.createExecutionState().recoverUnfinished("test:crash", { holderAlive: () => false });
		const outcome = await harness.turn(session.id, {}, (handle: HarnessSession) => agentTurn(handle));
		assert.equal(outcome.failure, undefined);
		assert.equal(outcome.value?.reply, "已采用报告");
		state = project.loadExecutionState();
		assert.equal(state.tasks.length, 1);
		assert.equal(state.tasks[0]?.id, childId);
		assert.equal(state.sessions[0]?.status, "idle");
		assert.equal(provider.state.callCount, 4);
	} finally {
		project.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("同一 turn 两次阶段提交；第一次 revision 已确认但动作结果丢失时，续跑按回执告诉模型已经提交，不重复提交", async (t) => {
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
			async (context) => {
				// 被打断的提交按回执说清已经提交成了哪个版本，模型不必再提交一次。
				assert.match(JSON.stringify(context.messages), /这次提交其实已经完成：版本 r2/u);
				return fauxAssistantMessage(
					fauxToolCall("write", {
						path: "world/characters/黄盖.md",
						content: "黄盖相信证据，愿意为自己的选择承担后果。",
					}),
				);
			},
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
