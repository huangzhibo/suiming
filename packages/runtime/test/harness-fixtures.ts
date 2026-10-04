/**
 * Agent / Harness 测试共用的小件：faux 网关、建在样例作品上的临时项目、作者说一句话跑完一个 turn。
 * 2026-10-04 之前 agent-source、agent-write、run-engine-rank 各写一份逐字相近的；这里是 test/ 下按相对路径引用的
 * 普通文件（AGENTS.md：不建 testing 包、不进产品导出面）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { agentTurn } from "../src/harness/agent.js";
import {
	LocalProjectService,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
	type SuimingHarness,
} from "../src/index.js";
import { sampleWorkFiles } from "./sample-work.js";

export type Responses = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

/**
 * 一个 faux provider 按顺序给出 responses；profiles 是「profile → 模型 id」。模型 id 照写在调用处，因为有的测试断言
 * 子任务用的是哪个模型。
 */
export function fauxGateway(
	providerId: string,
	responses: Responses,
	profiles: { main: string; reviewer: string } & Record<string, string>,
): ModelGateway {
	const provider = fauxProvider({
		provider: providerId,
		models: [...new Set(Object.values(profiles))].map((id) => ({ id })),
	});
	provider.setResponses(responses);
	const models = createModels();
	models.setProvider(provider.provider);
	return new ModelGateway(models, {
		profiles: Object.fromEntries(
			Object.entries(profiles).map(([profile, model]) => [profile, { provider: providerId, model }]),
		) as ConstructorParameters<typeof ModelGateway>[1]["profiles"],
	});
}

/** 样例作品（可加文件）落盘、init，跑完 body 后关掉并删目录。 */
export async function withSampleProject<T>(
	body: (project: LocalProjectService, checkoutPath: string) => Promise<T>,
	options: {
		projectId?: string;
		extraFiles?: Record<string, string>;
		prepare?(project: LocalProjectService): Promise<void>;
	} = {},
): Promise<T> {
	const checkoutPath = await mkdtemp(join(tmpdir(), "suiming-harness-"));
	await materializeOpenStoryDirectorySnapshot(checkoutPath, [
		...sampleWorkFiles(),
		...Object.entries(options.extraFiles ?? {}).map(([path, text]) => ({
			path,
			mediaType: "text/markdown; charset=utf-8",
			bytes: new TextEncoder().encode(text),
		})),
	]);
	let project: LocalProjectService | undefined;
	try {
		project = await LocalProjectService.init({ checkoutPath, projectId: options.projectId ?? "project-1" });
		await options.prepare?.(project);
		return await body(project, checkoutPath);
	} finally {
		project?.close();
		await rm(checkoutPath, { recursive: true, force: true });
	}
}

export const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));
export const reply = (text: string) => fauxAssistantMessage(text);

/** 上一条工具结果的文本；faux provider 的 Context 里工具结果是 toolResult 消息。 */
export function lastToolText(context: Context): string {
	const last = context.messages.at(-1);
	assert.equal(last?.role, "toolResult");
	const content = last?.content;
	assert.ok(Array.isArray(content));
	const body = content.find((part) => part.type === "text");
	assert.ok(body?.type === "text");
	return body.text;
}

/** 作者说一句话并跑完一个 turn；每次新建 session。 */
export async function say(harness: SuimingHarness, text: string) {
	const session = await harness.createSession();
	// 收件箱不在 Harness 的端口上（harness 只读 inbox）；测试里的 project 都是 LocalProjectService。
	(harness.project as LocalProjectService).queueInbox(session.id, text);
	return { sessionId: session.id, ...(await harness.turn(session.id, {}, (handle) => agentTurn(handle))) };
}
