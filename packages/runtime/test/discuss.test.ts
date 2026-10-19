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

// ADR-0039：讨论开关由工具面结构性保证，不靠模型自觉。走产品路径 LocalSessionController.send。

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
	const root = await mkdtemp(join(tmpdir(), "suiming-discuss-"));
	await materializeOpenStoryDirectorySnapshot(root, sampleWorkFiles());
	const declared: string[][] = [];
	const saved: string[] = [];
	// 作者在编辑器里有未保存的修改：Agent 读文件时会先把它存盘（ADR-0036），讨论开着时不该这样做。
	const editorFiles: EditorFileHandler = async (request) => {
		if (request.operation === "save") {
			saved.push(request.path);
			if (request.path === TEXT) await writeFile(join(root, TEXT), "作者没保存的草稿");
		}
		return null;
	};
	const provider = fauxProvider({ provider: "discuss-faux", models: [{ id: "agent-model" }] });
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
		project = await LocalProjectService.init({ checkoutPath: root, projectId: "project-discuss" });
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

test("讨论开着只读：没有写入、委派、审稿与提交；Agent 硬要写被拒，读文件也不替作者存草稿", async () => {
	let note = "";
	await withController(
		[
			(context) => {
				note = lastAuthorText(context);
				return call("read", { path: TEXT });
			},
			() => call("write", { path: BEAT, content: "改掉" }),
			() => fauxAssistantMessage("方案：把第一节的开场压短，等你关掉讨论再动手。"),
		],
		async ({ controller, project, root, declared, saved }) => {
			const before = await readFile(join(root, TEXT), "utf8");
			const beat = await readFile(join(root, BEAT), "utf8");
			const sent = await controller.send({ commandId: "discuss-1", text: "第一节改紧凑些", discuss: true });
			await controller.completion(sent.sessionId);

			const tools = declared[0] ?? [];
			for (const name of ["write", "edit", "copy", "move", "delete", "delegate", "review", "resume_task", "commit"])
				assert.ok(!tools.includes(name), `讨论开着不应声明 ${name}`);
			for (const name of ["read", "list", "search", "check", "project_status", "design_context"])
				assert.ok(tools.includes(name), `讨论开着应保留 ${name}`);
			assert.match(note, /讨论：开/, "收到消息时的系统附注写明讨论开着");
			assert.deepEqual(saved, [], "讨论开着读文件不同步作者草稿");
			assert.equal(await readFile(join(root, TEXT), "utf8"), before);
			assert.equal(await readFile(join(root, BEAT), "utf8"), beat, "硬要写也写不进去");
			const session = project.loadExecutionEntities().sessions.find((item) => item.id === sent.sessionId);
			assert.equal(session?.discuss, true);
			assert.equal(session?.status, "idle");
		},
	);
});

test("讨论随对话保留，关掉才有写入与 commit；新对话默认关着", async () => {
	await withController(
		[
			() => fauxAssistantMessage("先说方案。"),
			() => fauxAssistantMessage("还在讨论。"),
			() => call("edit", { path: BEAT, oldText: "杖责五十", newText: "杖责六十" }),
			() => fauxAssistantMessage("改好了。"),
			() => fauxAssistantMessage("新对话。"),
		],
		async ({ controller, project, declared }) => {
			const sent = await controller.send({ commandId: "d-1", text: "第一节怎么改", discuss: true });
			await controller.completion(sent.sessionId);
			assert.ok(!declared[0]?.includes("edit") && !declared[0]?.includes("commit"));

			// 不带开关的下一句沿用上一次的设置
			await controller.send({ commandId: "d-2", text: "再想想", sessionId: sent.sessionId });
			await controller.completion(sent.sessionId);
			assert.ok(!declared[1]?.includes("edit"), "讨论沿用到下一轮");

			await controller.send({ commandId: "d-3", text: "照这个改", sessionId: sent.sessionId, discuss: false });
			await controller.completion(sent.sessionId);
			for (const name of ["edit", "delegate", "review", "commit"])
				assert.ok(declared[2]?.includes(name), `关掉讨论后应声明 ${name}`);
			const session = project.loadExecutionEntities().sessions.find((item) => item.id === sent.sessionId);
			assert.equal(session?.discuss, false);

			const fresh = await controller.send({ commandId: "d-4", text: "另起一段" });
			await controller.completion(fresh.sessionId);
			assert.ok(declared[4]?.includes("commit"), "新对话默认关着讨论");
		},
	);
});

test("对话正在跑时开关讨论明确拒绝，不排进去悄悄失效", async () => {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	// 第一次回复挂到测完「跑着时开讨论」才回来，保证那时对话确实在跑
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
				controller.send({ commandId: "run-2", text: "先讨论", sessionId: sent.sessionId, discuss: true }),
				(error: unknown) => error instanceof ArtifactError && error.code === "session_running",
			);
			// 不碰讨论开关的插话照常排进去
			await controller.send({ commandId: "run-3", text: "顺便看看大纲", sessionId: sent.sessionId });
			release();
			await controller.completion(sent.sessionId);
			const session = project.loadExecutionEntities().sessions.find((item) => item.id === sent.sessionId);
			assert.notEqual(session?.discuss, true);
			assert.deepEqual(
				project.readInbox(sent.sessionId).map((item) => item.text),
				["写第一节", "顺便看看大纲"],
			);
		},
	);
});
