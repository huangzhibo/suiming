import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import {
	LocalModelSettings,
	LocalProjectService,
	LocalWorkspace,
	loadModelRoutingConfig,
	ModelGateway,
	materializeOpenStoryDirectorySnapshot,
} from "../src/index.js";
import { configuredThinking, thinkingLevels, withThinking } from "../src/model/thinking-options.js";
import { sampleWorkFiles } from "./sample-work.js";

const _answer = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args));
async function idle(workspace: LocalWorkspace) {
	for (let i = 0; i < 500; i++) {
		if (!workspace.activeSessionIds().length) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("对话没有结束");
}

test("session 的模型独立于全局默认，思考参数真实传入；turn 边界换绑与设置保存都不打断当前回复", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-model-choice-"));
	const checkout = join(root, "work");
	await materializeOpenStoryDirectorySnapshot(checkout, sampleWorkFiles());
	const project = await LocalProjectService.init({ checkoutPath: checkout });
	const provider = fauxProvider({
		provider: "model-choice",
		api: "openai-responses",
		models: [
			{ id: "first", reasoning: true },
			{ id: "second", reasoning: true },
		],
	});
	const models = createModels();
	models.setProvider(provider.provider);
	const configPath = join(root, "config.toml");
	const settings = new LocalModelSettings({ models, configPath });
	await settings.save({ profile: "main", provider: provider.provider.id, model: "first", thinking: "low" });
	await settings.save({ profile: "reviewer", provider: provider.provider.id, model: "first" });
	let configLoads = 0;
	const workspace = new LocalWorkspace(
		project,
		async () => {
			configLoads++;
			const config = (await loadModelRoutingConfig({ configPath, environment: {} })).config;
			// 不可用的专用角色不应阻止普通聊天。
			return new ModelGateway(models, {
				profiles: { ...config.profiles, writer: { provider: "unconfigured", model: "missing" } },
			});
		},
		settings,
	);
	const choice = { provider: provider.provider.id, model: "second", thinking: "high" as const };
	try {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		provider.setResponses([
			async (_context, options, _state, model) => {
				assert.equal(model.id, "second");
				assert.equal((options as Record<string, unknown>).reasoningEffort, "high");
				await gate;
				return fauxAssistantMessage("要公开密信吗？");
			},
			async (context, options, _state, model) => {
				assert.equal(model.id, "first");
				assert.equal((options as Record<string, unknown>).reasoningEffort, "medium");
				assert.match(JSON.stringify(context.messages), /要公开密信吗/, "换绑接着同一份消息列表");
				return fauxAssistantMessage("继续同一对话，保留已确认的选择。");
			},
			async (_context, options, _state, model) => {
				assert.equal(model.id, "first");
				assert.equal((options as Record<string, unknown>).reasoningEffort, "high");
				return fauxAssistantMessage("新 session 使用更新后的默认配置。");
			},
		]);
		const send = { commandId: "send-choice", text: "讨论公开密信", model: choice };
		const started = await workspace.invoke("session.send", send);
		assert.deepEqual(await workspace.invoke("session.send", send), started);
		await assert.rejects(workspace.invoke("session.send", { ...send, model: { ...choice, thinking: "low" } }), {
			code: "command_conflict",
		});
		await workspace.invoke("models.save", {
			profile: "main",
			provider: provider.provider.id,
			model: "first",
			thinking: "high",
		});
		assert.ok(workspace.activeSessionIds().includes(started.sessionId), "保存默认值不停止当前回复");
		release();
		await idle(workspace);
		assert.equal(project.loadExecutionState().sessions[0]?.status, "idle");
		assert.deepEqual((await workspace.invoke("session.list", {})).sessions[0]?.model, choice);
		const next = {
			commandId: "switch-choice",
			text: "公开",
			sessionId: started.sessionId,
			model: { provider: provider.provider.id, model: "first", thinking: "medium" as const },
		};
		const switched = await workspace.invoke("session.send", next);
		assert.deepEqual(switched, { sessionId: started.sessionId, sequence: 2 });
		await idle(workspace);
		assert.deepEqual(await workspace.invoke("session.send", next), switched, "同一命令重发返回原回执，不再开 turn");
		await idle(workspace);
		await assert.rejects(workspace.invoke("session.send", { ...next, model: choice }), { code: "command_conflict" });
		const state = project.loadExecutionState();
		assert.equal(state.sessions.length, 1);
		assert.equal(state.sessions[0]?.turn, 2);
		assert.deepEqual((await workspace.invoke("session.list", {})).sessions[0]?.model, next.model);
		assert.equal(state.sessions[0]?.status, "idle");
		assert.equal(
			(await workspace.invoke("models.show", {})).profiles.find((profile) => profile.id === "main")?.thinking,
			"high",
			"临时思考深度不写回默认设置",
		);
		await workspace.invoke("session.send", { commandId: "new-default", text: "新对话" });
		await idle(workspace);
		assert.equal(configLoads, 2, "只在默认配置改变后重建闲置控制器");
		assert.equal(provider.state.callCount, 3);
		assert.equal((await project.history()).length, 1);
	} finally {
		await workspace.shutdown();
		project.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("思考档位按模型能力校验，映射实际 API 字段，关闭与默认清除旧参数", () => {
	const base = fauxProvider({ models: [{ id: "reasoning", reasoning: true, maxTokens: 32000 }] }).getModel();
	const openai = { ...base, api: "openai-responses", thinkingLevelMap: { off: null, xhigh: "xhigh" } };
	assert.ok(!thinkingLevels(openai).includes("off"));
	assert.ok(thinkingLevels(openai).includes("xhigh"));
	assert.throws(() => withThinking(openai, {}, "off"), { code: "invalid_model_options" });
	assert.deepEqual(withThinking(openai, { temperature: 0.3, reasoningEffort: "low" }, "xhigh"), {
		temperature: 0.3,
		reasoningEffort: "xhigh",
	});
	assert.deepEqual(withThinking(openai, { reasoningEffort: "high", temperature: 0.3 }, "default"), {
		temperature: 0.3,
	});
	const anthropic = { ...base, api: "anthropic-messages", compat: { forceAdaptiveThinking: true } };
	assert.deepEqual(withThinking(anthropic, {}, "high"), { thinkingEnabled: true, effort: "high" });
	assert.deepEqual(withThinking(anthropic, { thinkingEnabled: true, effort: "high" }, "off"), {
		thinkingEnabled: false,
	});
	assert.equal(configuredThinking(anthropic, withThinking(anthropic, {}, "medium")), "medium");
	const fixed = { ...base, api: "anthropic-messages", maxTokens: 16000 };
	const options = withThinking(fixed, {}, "high");
	assert.ok(Number(options.thinkingBudgetTokens) < Number(options.maxTokens));
	const google = { ...base, api: "google-generative-ai", id: "gemini-3-pro" };
	assert.deepEqual(withThinking(google, {}, "medium"), { thinking: { enabled: true, level: "HIGH" } });
	assert.deepEqual(withThinking({ ...google, id: "gemini-3.1-pro" }, {}, "medium"), {
		thinking: { enabled: true, level: "HIGH" },
	});
	assert.equal(withThinking(fixed, { maxTokens: 4096 }, "high").maxTokens, 4096);
	assert.deepEqual(withThinking({ ...base, api: "openai-codex-responses" }, {}, "off"), { reasoningEffort: "none" });
	assert.deepEqual(thinkingLevels({ ...base, api: "custom" }), []);
	assert.deepEqual(thinkingLevels({ ...openai, reasoning: false }), []);
});

test("设置保留有损映射前的思考档位；环境换模型时不继承旧档位", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-thinking-config-"));
	const provider = fauxProvider({
		provider: "adaptive-test",
		api: "anthropic-messages",
		models: [{ id: "adaptive", reasoning: true }],
	});
	Object.assign(provider.getModel(), { compat: { forceAdaptiveThinking: true } });
	const models = createModels();
	models.setProvider(provider.provider);
	const configPath = join(root, "config.toml");
	const settings = new LocalModelSettings({ models, configPath });
	try {
		await settings.save({ profile: "main", provider: provider.provider.id, model: "adaptive", thinking: "low" });
		assert.equal((await settings.show()).profiles[0]?.thinking, "low", "不能由 effort=low 反推成 minimal");
		const config = (await loadModelRoutingConfig({ configPath, environment: {} })).config;
		assert.equal(config.profiles.main.thinking, "low");
		assert.deepEqual(config.profiles.main.options, {});
		const snapshot = (await new ModelGateway(models, config).bind("main")).snapshot;
		assert.equal(snapshot.thinking, "low");
		assert.equal(snapshot.options.effort, "low");
		const changed = (
			await loadModelRoutingConfig({ configPath, environment: { SUIMING_MAIN_MODEL_ID: "different" } })
		).config;
		assert.equal(changed.profiles.main.thinking, undefined);
		assert.equal(changed.profiles.writer?.thinking, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
