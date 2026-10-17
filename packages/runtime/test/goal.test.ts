import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import {
	ArtifactError,
	LocalProjectService,
	LocalSessionController,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
} from "../src/index.js";
import { assertAgUiConformance } from "./harness-fixtures.js";
import { sampleWorkFiles } from "./sample-work.js";

// ADR-0038 决定二：作者设定的目标在 turn 结束后自动续跑；完成与「需要作者拍板」由模型标，系统核对事实、
// 兜住用量与空转。走产品路径 LocalSessionController。

type Response = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));
const reply = (text: string) => fauxAssistantMessage(text);
/** 4 万字的输出折算 5 万用量（输出按五倍），一次就把检查点用掉一大半；同 agent.test.ts 的 expensive。 */
const expensive = (toolCall: ReturnType<typeof fauxToolCall>) =>
	fauxAssistantMessage([fauxText("x".repeat(40_000)), toolCall]);
const BEAT = "outline/story/vol-0001/beat-0001.md";
const edit = (from: string, to: string) => call("edit", { path: BEAT, oldText: from, newText: to });

function lastUser(context: Context): string {
	const message = context.messages.filter((item) => item.role === "user").at(-1);
	const content = message?.content;
	return typeof content === "string"
		? content
		: (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

function lastToolText(context: Context): string {
	return JSON.stringify(context.messages.at(-1));
}

async function withController(
	responses: Response[],
	body: (input: {
		controller: LocalSessionController;
		project: LocalProjectService;
		provider: ReturnType<typeof fauxProvider>;
	}) => Promise<void>,
	options: { usageCheckpoint?: number } = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "suiming-goal-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const provider = fauxProvider({ provider: "goal-faux", models: [{ id: "agent-model" }] });
	provider.setResponses(responses);
	const models = createModels();
	models.setProvider(provider.provider);
	const gateway = new ModelGateway(models, {
		profiles: {
			main: { provider: provider.provider.id, model: "agent-model" },
			reviewer: { provider: provider.provider.id, model: "agent-model" },
		},
	});
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-goal" });
		const controller = new LocalSessionController({
			project,
			models: gateway,
			...(options.usageCheckpoint === undefined
				? {}
				: { usageCheckpoint: async () => options.usageCheckpoint as number }),
		});
		await body({ controller, project, provider });
		// 续跑的进度事件也要落在某次运行之内，桌面的 AG-UI 官方客户端才不会整条流报错
		await assertAgUiConformance(project);
	} finally {
		project?.close();
		await rm(root, { recursive: true, force: true });
	}
}

const session = (project: LocalProjectService, id: string) =>
	project.loadExecutionEntities().sessions.find((item) => item.id === id);

test("设了目标，turn 结束自动续下一轮；续跑消息不是作者说的；模型标完成就停，并拿到确定性核对", async () => {
	let firstNote = "";
	let continuation = "";
	let completion = "";
	await withController(
		[
			(context) => {
				firstNote = lastUser(context);
				return edit("杖责五十", "杖责六十");
			},
			reply("先改了第一节，还没提交。"),
			(context) => {
				continuation = lastUser(context);
				return call("update_goal", { status: "complete", reason: "第一节已按要求改好" });
			},
			(context) => {
				completion = lastToolText(context);
				return reply("目标完成。");
			},
		],
		async ({ controller, project, provider }) => {
			const sent = await controller.send({ commandId: "goal-1", text: "把第一节的杖数改成六十", goal: true });
			await controller.completion(sent.sessionId);

			assert.match(firstNote, /当前目标/, "作者消息的附注写明有目标");
			assert.match(continuation, /按作者设定的目标继续/);
			assert.match(continuation, /不是作者的新消息/);
			assert.match(continuation, /把第一节的杖数改成六十/);
			assert.match(completion, /未提交/, "标完成时拿到系统核对的事实");
			const record = session(project, sent.sessionId);
			assert.equal(record?.goal?.status, "complete");
			assert.equal(record?.goal?.reason, "第一节已按要求改好");
			assert.equal(record?.goal?.autoTurns, 1);
			assert.equal(record?.turn, 2);
			assert.equal(provider.state.callCount, 4);
			assert.deepEqual(
				project.readInbox(sent.sessionId).map((item) => item.text),
				["把第一节的杖数改成六十"],
				"续跑消息不进作者的 inbox",
			);
			const summaries = project
				.readSessionEvents(sent.sessionId)
				.map((record) => record.event)
				.filter((event) => event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.turn")
				.map((event) => (event as unknown as { content: { authorMessages: number } }).content.authorMessages);
			assert.deepEqual(summaries, [1, 0], "续跑那一轮的作者消息数是 0");
		},
	);
});

test("需要作者拍板时标 blocked，续跑停下；作者回一句目标回到 active 接着跑", async () => {
	await withController(
		[
			call("update_goal", { status: "blocked", reason: "改杖数要不要连带改人物档，需要你定" }),
			reply("要不要连人物档一起改？"),
			edit("杖责五十", "杖责六十"),
			reply("按你说的只改了情节。"),
			call("update_goal", { status: "complete", reason: "只改情节，已完成" }),
			reply("完成。"),
		],
		async ({ controller, project, provider }) => {
			const sent = await controller.send({ commandId: "goal-b1", text: "把第一节的杖数改成六十", goal: true });
			await controller.completion(sent.sessionId);
			assert.equal(session(project, sent.sessionId)?.goal?.status, "blocked");
			assert.equal(provider.state.callCount, 2, "标 blocked 之后没有续跑");

			await controller.send({ commandId: "goal-b2", text: "只改情节", sessionId: sent.sessionId });
			await controller.completion(sent.sessionId);
			const record = session(project, sent.sessionId);
			assert.equal(record?.goal?.status, "complete");
			assert.equal(provider.state.callCount, 6);
		},
	);
});

test("自动续的一轮什么都没改就停下，不再续跑", async () => {
	await withController(
		[edit("杖责五十", "杖责六十"), reply("改了一处。"), reply("我觉得差不多了。"), reply("不该再有这一轮")],
		async ({ controller, project, provider }) => {
			const sent = await controller.send({ commandId: "goal-n1", text: "把第一节改好", goal: true });
			await controller.completion(sent.sessionId);
			const record = session(project, sent.sessionId);
			assert.equal(record?.goal?.status, "blocked");
			assert.match(record?.goal?.reason ?? "", /没有改动/);
			assert.equal(provider.state.callCount, 3);
		},
	);
});

test("用量检查点按作者开的那一轮计：自动续的轮次累计进去，撞线即停，目标仍是 active", async () => {
	await withController(
		[
			expensive(fauxToolCall("edit", { path: BEAT, oldText: "杖责五十", newText: "杖责六十" })),
			reply("先改了一处。"),
			expensive(fauxToolCall("edit", { path: BEAT, oldText: "杖责六十", newText: "杖责七十" })),
			reply("没有检查点兜底才会发出的请求"),
		],
		async ({ controller, project, provider }) => {
			const sent = await controller.send({ commandId: "goal-u1", text: "一直改下去", goal: true });
			await controller.completion(sent.sessionId);
			const record = session(project, sent.sessionId);
			assert.equal(record?.lastFailure?.code, "turn_usage_checkpoint");
			assert.equal(provider.state.callCount, 3, "第二轮的第二次请求之前就停了：第一轮的用量带进了续跑");
			assert.equal(record?.goal?.status, "active", "停在检查点不改目标，作者说继续就接着跑");
		},
		{ usageCheckpoint: 80_000 },
	);
});

test("作者停止当前回复，目标转为暂停、不再续跑；跑着的时候不能改目标；resume 才接着跑，clear 去掉目标", async () => {
	let entered: () => void = () => undefined;
	const running = new Promise<void>((resolve) => {
		entered = resolve;
	});
	await withController(
		[
			async (_context, options) => {
				entered();
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				options?.signal?.throwIfAborted();
				return reply("不会到这里");
			},
			call("update_goal", { status: "complete", reason: "接着做完了" }),
			reply("完成。"),
		],
		async ({ controller, project, provider }) => {
			const sent = await controller.send({ commandId: "goal-p1", text: "把第一节改好", goal: true });
			await running;
			await assert.rejects(
				controller.updateGoal({ commandId: "goal-p2", sessionId: sent.sessionId, action: "pause" }),
				(error: unknown) => error instanceof ArtifactError && error.code === "session_running",
			);
			controller.interrupt(sent.sessionId);
			await controller.completion(sent.sessionId);
			assert.equal(session(project, sent.sessionId)?.goal?.status, "paused");
			assert.deepEqual(controller.activeSessionIds(), [], "停下之后没有自动续跑");
			assert.equal(provider.state.callCount, 1);

			await controller.updateGoal({ commandId: "goal-p3", sessionId: sent.sessionId, action: "resume" });
			await controller.completion(sent.sessionId);
			assert.equal(session(project, sent.sessionId)?.goal?.status, "complete");
			assert.equal(provider.state.callCount, 3);
			assert.deepEqual(
				project.readInbox(sent.sessionId).map((item) => item.text),
				["把第一节改好"],
				"resume 不冒充作者说话",
			);

			await controller.updateGoal({ commandId: "goal-p4", sessionId: sent.sessionId, action: "clear" });
			assert.equal(session(project, sent.sessionId)?.goal, undefined);
		},
	);
});
