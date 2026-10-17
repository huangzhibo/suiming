import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import type { EditorFileHandler } from "@suiming/sdk";
import {
	ArtifactError,
	LocalProjectService,
	LocalSessionController,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

// ADR-0038 决定一：协作模式由工具面结构性保证，不靠模型自觉。走产品路径 LocalSessionController.send。

type Step = (
	context: Context,
) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;

const BEAT = "outline/story/vol-0001/beat-0001.md";
const TEXT = "world/core.md";

async function withController(
	steps: Step[],
	body: (input: {
		controller: LocalSessionController;
		project: LocalProjectService;
		root: string;
		declared: string[][];
		saved: string[];
	}) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "suiming-collaboration-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const declared: string[][] = [];
	const saved: string[] = [];
	// 作者在编辑器里有未保存的修改：Agent 读文件时会先把它存盘（ADR-0036），讨论模式不该这样做。
	const editorFiles: EditorFileHandler = async (request) => {
		if (request.operation === "save") {
			saved.push(request.path);
			if (request.path === TEXT) await writeFile(join(root, TEXT), "作者没保存的草稿");
		}
		return null;
	};
	const provider = fauxProvider({ provider: "collaboration-faux", models: [{ id: "agent-model" }] });
	provider.setResponses(
		steps.map((step) => async (context: Context) => {
			declared.push(declaredTools(context));
			return step(context);
		}),
	);
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
		project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-collaboration" });
		const controller = new LocalSessionController({ project, models: gateway, editorFiles });
		await body({ controller, project, root, declared, saved });
	} finally {
		project?.close();
		await rm(root, { recursive: true, force: true });
	}
}

/** pi-ai 1.2 把工具声明折进 system 消息，以 toolsAdded / toolsRemoved 增减；按顺序累加就是这次请求实际声明的工具。 */
function declaredTools(context: Context): string[] {
	const names = new Set<string>();
	for (const message of context.messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
	}
	return [...names];
}

function lastAuthorText(context: Context): string {
	const author = context.messages.filter((message) => message.role === "user").at(-1);
	const content = author?.content;
	return typeof content === "string"
		? content
		: (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));

test("讨论模式只读：没有写入、委派、审稿与提交；Agent 硬要写被拒，读文件也不替作者存草稿", async () => {
	let note = "";
	await withController(
		[
			(context) => {
				note = lastAuthorText(context);
				return call("read", { path: TEXT });
			},
			() => call("write", { path: BEAT, content: "改掉" }),
			() => fauxAssistantMessage("方案：把第一节的开场压短，等你切到协作再动手。"),
		],
		async ({ controller, project, root, declared, saved }) => {
			const before = await readFile(join(root, TEXT), "utf8");
			const beat = await readFile(join(root, BEAT), "utf8");
			const sent = await controller.send({ commandId: "discuss-1", text: "第一节改紧凑些", mode: "discuss" });
			await controller.completion(sent.sessionId);

			const tools = declared[0] ?? [];
			for (const name of ["write", "edit", "copy", "move", "delete", "delegate", "review", "resume_task", "commit"])
				assert.ok(!tools.includes(name), `讨论模式不应声明 ${name}`);
			for (const name of ["read", "list", "search", "check", "project_status"])
				assert.ok(tools.includes(name), `讨论模式应保留 ${name}`);
			assert.match(note, /讨论/, "收到消息时的系统附注写明当前模式");
			assert.deepEqual(saved, [], "讨论模式读文件不同步作者草稿");
			assert.equal(await readFile(join(root, TEXT), "utf8"), before);
			assert.equal(await readFile(join(root, BEAT), "utf8"), beat, "硬要写也写不进去");
			const session = project.loadExecutionEntities().sessions.find((item) => item.id === sent.sessionId);
			assert.equal(session?.collaboration, "discuss");
			assert.equal(session?.status, "idle");
		},
	);
});

test("协作模式能改候选不能提交；模式随对话保留，切回自主才有 commit", async () => {
	await withController(
		[
			() => call("edit", { path: BEAT, oldText: "杖责五十", newText: "杖责六十" }),
			() => fauxAssistantMessage("改好了，候选里改了第一节的情节设计，等你提交。"),
			() => fauxAssistantMessage("还是协作模式。"),
			() => fauxAssistantMessage("现在可以提交了。"),
		],
		async ({ controller, project, declared }) => {
			const genesis = project.project().headRevisionId;
			const sent = await controller.send({ commandId: "co-1", text: "把第一节改一下", mode: "collaborate" });
			await controller.completion(sent.sessionId);
			assert.ok(declared[0]?.includes("edit") && declared[0].includes("delegate"));
			assert.ok(!declared[0]?.includes("commit"), "协作模式没有 commit");
			assert.equal(project.project().headRevisionId, genesis, "Canon 没有推进");

			// 不带模式的下一句沿用上一次的选择
			await controller.send({ commandId: "co-2", text: "继续", sessionId: sent.sessionId });
			await controller.completion(sent.sessionId);
			assert.ok(!declared[2]?.includes("commit"));

			await controller.send({ commandId: "co-3", text: "可以了", sessionId: sent.sessionId, mode: "autonomous" });
			await controller.completion(sent.sessionId);
			assert.ok(declared[3]?.includes("commit"), "切回自主才有 commit");
			const session = project.loadExecutionEntities().sessions.find((item) => item.id === sent.sessionId);
			assert.equal(session?.collaboration, "autonomous");
		},
	);
});

test("对话正在跑时换模式明确拒绝，不排进去悄悄失效", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	// 第一次回复挂到测完「跑着时换模式」才回来，保证那时对话确实在跑
	let entered: () => void = () => undefined;
	const running = new Promise<void>((resolve) => {
		entered = resolve;
	});
	await withController(
		[
			async () => {
				entered();
				await gate;
				return fauxAssistantMessage("在想。");
			},
			() => fauxAssistantMessage("看过了。"),
		],
		async ({ controller, project }) => {
			const sent = await controller.send({ commandId: "run-1", text: "写第一节" });
			await running;
			await assert.rejects(
				controller.send({ commandId: "run-2", text: "先讨论", sessionId: sent.sessionId, mode: "discuss" }),
				(error: unknown) => error instanceof ArtifactError && error.code === "session_running",
			);
			// 不改模式的插话照常排进去
			await controller.send({ commandId: "run-3", text: "顺便看看大纲", sessionId: sent.sessionId });
			release();
			await controller.completion(sent.sessionId);
			const session = project.loadExecutionEntities().sessions.find((item) => item.id === sent.sessionId);
			assert.notEqual(session?.collaboration, "discuss");
			assert.deepEqual(
				project.readInbox(sent.sessionId).map((item) => item.text),
				["写第一节", "顺便看看大纲"],
			);
		},
	);
});
