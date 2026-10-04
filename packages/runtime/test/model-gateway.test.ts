import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import {
	JsonFileCredentialStore,
	loadCloudConnectionConfig,
	loadModelRoutingConfig,
	ModelGateway,
	ModelGatewayError,
	type ModelProfileOptions,
	type ModelRoutingConfig,
} from "../src/index.js";

test("用户 config.toml 与环境覆盖按固定优先级解析", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-model-config-"));
	const configPath = join(root, "config.toml");
	try {
		await writeFile(
			configPath,
			`version = 1

[models.profiles.main]
provider = "user-provider"
model = "user-model"

[models.profiles.main.options]
maxTokens = 8192
reasoningEffort = "high"
retry = { attempts = 2, backoff = [100, 200] }

[models.profiles.reviewer]
provider = "review-provider"
model = "review-model"

[models.profiles.source-reader]
provider = "reader-provider"
model = "reader-model"

[models.profiles.source-extractor]
provider = "extractor-provider"
model = "extractor-model"

[cloud]
endpoint = "https://cloud.user.example/api"
actor_id = "author-user"
`,
		);
		const loaded = await loadModelRoutingConfig({
			configPath,
			environment: {
				SUIMING_MAIN_MODEL_ID: "environment-model",
				SUIMING_REVIEWER_MODEL_OPTIONS: '{"maxTokens":4096}',
				SUIMING_SOURCE_READER_MODEL_ID: "environment-reader-model",
			},
		});
		assert.deepEqual(loaded.config.profiles.main, {
			provider: "user-provider",
			model: "environment-model",
			options: { maxTokens: 8192, reasoningEffort: "high", retry: { attempts: 2, backoff: [100, 200] } },
		});
		assert.deepEqual(loaded.config.profiles.reviewer, {
			provider: "review-provider",
			model: "review-model",
			options: { maxTokens: 4096 },
		});
		assert.deepEqual(loaded.config.profiles["source-reader"], {
			provider: "reader-provider",
			model: "environment-reader-model",
		});
		assert.deepEqual(loaded.config.profiles["source-extractor"], {
			provider: "extractor-provider",
			model: "extractor-model",
		});
		assert.equal(loaded.diagnostic.configFile, "loaded");
		assert.equal(loaded.diagnostic.profiles.main.providerSource, "user-config");
		assert.equal(loaded.diagnostic.profiles.main.modelSource, "environment");
		assert.equal(loaded.diagnostic.profiles.reviewer.providerSource, "user-config");
		assert.equal(loaded.diagnostic.profiles.reviewer.optionsSource, "environment");
		assert.deepEqual(loaded.diagnostic.profiles.main.optionKeys, ["maxTokens", "reasoningEffort", "retry"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Cloud connection 复用 ~/.suiming/config.toml，环境变量保持更高优先级", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-cloud-config-"));
	const configPath = join(root, "config.toml");
	try {
		await writeFile(
			configPath,
			'version = 1\n[cloud]\nendpoint = "https://cloud.user.example/api"\nactor_id = "author-user"\n',
		);
		const loaded = await loadCloudConnectionConfig({
			configPath,
			environment: { SUIMING_CLOUD_ACTOR_ID: "author-environment" },
		});
		assert.deepEqual(loaded.config, {
			endpoint: "https://cloud.user.example/api",
			actorId: "author-environment",
		});
		assert.equal(loaded.diagnostic.configFile, "loaded");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("用户配置省略 Reviewer 时复用 Agent，显式缺失路径给出诊断", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-model-config-"));
	const configPath = join(root, "config.toml");
	try {
		await writeFile(configPath, 'version = 1\n[models.profiles.main]\nprovider = "provider-a"\nmodel = "model-a"\n');
		const loaded = await loadModelRoutingConfig({ configPath, environment: {} });
		assert.deepEqual(loaded.config.profiles.reviewer, loaded.config.profiles.main);
		assert.deepEqual(loaded.config.profiles["source-reader"], loaded.config.profiles.main);
		assert.deepEqual(loaded.config.profiles["source-extractor"], loaded.config.profiles.main);
		assert.equal(loaded.diagnostic.profiles.reviewer.providerSource, "main-default");
		assert.equal(loaded.diagnostic.profiles["source-reader"].providerSource, "main-default");
		await assert.rejects(
			() => loadModelRoutingConfig({ configPath: join(root, "missing.toml"), environment: {} }),
			(error: unknown) => error instanceof ModelGatewayError && error.code === "model_config_not_found",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("JsonFileCredentialStore 原子保存 provider-scoped 凭据并强制 0600", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-auth-"));
	const path = join(root, "auth.json");
	try {
		const store = new JsonFileCredentialStore({ path });
		await store.modify("provider-a", async () => ({ type: "api_key", key: "test-secret" }));
		assert.deepEqual(await store.list(), [{ providerId: "provider-a", type: "api_key" }]);
		assert.deepEqual(await store.read("provider-a"), { type: "api_key", key: "test-secret" });
		assert.equal((await stat(path)).mode & 0o777, 0o600);

		await chmod(path, 0o644);
		await assert.rejects(
			() => store.read("provider-a"),
			(error: unknown) => error instanceof ModelGatewayError && error.code === "credential_store_permissions",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function withEmptyConfig<T>(body: (configPath: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "suiming-env-config-"));
	const configPath = join(root, "config.toml");
	await writeFile(configPath, "version = 1\n");
	try {
		return await body(configPath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("环境配置允许其它 profile 复用 Agent，也允许逐个独立覆盖", async () => {
	await withEmptyConfig(async (configPath) => {
		const shared = await loadModelRoutingConfig({
			configPath,
			environment: {
				SUIMING_MAIN_MODEL_PROVIDER: "provider-a",
				SUIMING_MAIN_MODEL_ID: "model-a",
				SUIMING_MAIN_MODEL_OPTIONS: '{"temperature":0.4}',
			},
		});
		assert.deepEqual(shared.config.profiles.reviewer, shared.config.profiles.main);
		assert.deepEqual(shared.config.profiles["source-reader"], shared.config.profiles.main);
		assert.deepEqual(shared.config.profiles["source-extractor"], shared.config.profiles.main);
		assert.equal(shared.diagnostic.profiles.writer.providerSource, "main-default");

		const separate = await loadModelRoutingConfig({
			configPath,
			environment: {
				SUIMING_MAIN_MODEL_PROVIDER: "provider-a",
				SUIMING_MAIN_MODEL_ID: "model-a",
				SUIMING_REVIEWER_MODEL_PROVIDER: "provider-b",
				SUIMING_REVIEWER_MODEL_ID: "model-b",
				SUIMING_REVIEWER_MODEL_OPTIONS: '{"maxTokens":4096}',
				SUIMING_SOURCE_EXTRACTOR_MODEL_PROVIDER: "provider-d",
				SUIMING_SOURCE_EXTRACTOR_MODEL_ID: "model-d",
				SUIMING_SOURCE_EXTRACTOR_MODEL_OPTIONS: '{"maxTokens":32768}',
			},
		});
		assert.deepEqual(separate.config.profiles.reviewer, {
			provider: "provider-b",
			model: "model-b",
			options: { maxTokens: 4096 },
		});
		assert.deepEqual(separate.config.profiles["source-reader"], separate.config.profiles.main);
		assert.deepEqual(separate.config.profiles["source-extractor"], {
			provider: "provider-d",
			model: "model-d",
			options: { maxTokens: 32768 },
		});
	});
});

test("环境配置拒绝缺失或不完整的 model profile", async () => {
	await withEmptyConfig(async (configPath) => {
		await assert.rejects(
			() => loadModelRoutingConfig({ configPath, environment: {} }),
			(error: unknown) => error instanceof ModelGatewayError && error.code === "missing_model_config",
		);
		await assert.rejects(
			() =>
				loadModelRoutingConfig({
					configPath,
					environment: {
						SUIMING_MAIN_MODEL_PROVIDER: "provider-a",
						SUIMING_MAIN_MODEL_ID: "model-a",
						SUIMING_REVIEWER_MODEL_PROVIDER: "provider-b",
					},
				}),
			(error: unknown) => error instanceof ModelGatewayError && error.code === "missing_model_config",
		);
		await assert.rejects(
			() =>
				loadModelRoutingConfig({
					configPath,
					environment: {
						SUIMING_MAIN_MODEL_PROVIDER: "provider-a",
						SUIMING_MAIN_MODEL_ID: "model-a",
						SUIMING_SOURCE_READER_MODEL_ID: "model-c",
					},
				}),
			(error: unknown) => error instanceof ModelGatewayError && error.code === "missing_model_config",
		);
	});
});

test("config.toml 由 smol-toml 解析，Suiming 只校验形状：未知表、未知键、日期与坏语法都报错", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-toml-"));
	const configPath = join(root, "config.toml");
	const expectInvalid = async (source: string) => {
		await writeFile(configPath, source);
		await assert.rejects(
			() => loadModelRoutingConfig({ configPath, environment: {} }),
			(error: unknown) => error instanceof ModelGatewayError && error.code === "invalid_model_config_file",
			source,
		);
	};
	try {
		await expectInvalid("version = 2\n");
		await expectInvalid('version = 1\n[unknown]\nkey = "value"\n');
		await expectInvalid('version = 1\n[models.profiles.main]\nprovider = "p"\nmodel = "m"\nretries = 3\n');
		await expectInvalid("version = 1\n[models.profiles.main.options]\nsince = 2026-09-05\n");
		await expectInvalid('version = 1\n[models.profiles.main]\nprovider = "p"\nprovider = "q"\n');
		await expectInvalid("version = 1\n[models.profiles.main\n");
		await writeFile(
			configPath,
			'version = 1\n[models.profiles.main]\nprovider = "p"\nmodel = "m"\n[models.profiles.main.options]\nmaxTokens = 8_192\nsamplingParams = { top_p = 0.9, stop = ["END"] }\n',
		);
		const loaded = await loadModelRoutingConfig({ configPath, environment: {} });
		assert.deepEqual(loaded.config.profiles.main.options, {
			maxTokens: 8192,
			samplingParams: { top_p: 0.9, stop: ["END"] },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function routingConfig(provider: string): ModelRoutingConfig {
	return {
		profiles: {
			main: { provider, model: "agent-model", options: { temperature: 0.2 } },
			reviewer: { provider, model: "reviewer-model", options: { maxTokens: 2048 } },
		},
	};
}

test("Model Gateway 按任务绑定模型，并冻结不含密钥的调用快照", async () => {
	const faux = fauxProvider({
		provider: "suiming-faux",
		models: [{ id: "agent-model" }, { id: "reviewer-model" }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const gateway = new ModelGateway(models, routingConfig("suiming-faux"));
	faux.setResponses([
		fauxAssistantMessage("agent result"),
		fauxAssistantMessage("reviewer result"),
		fauxAssistantMessage("source reader result"),
		fauxAssistantMessage("source extractor result"),
	]);

	const agent = await gateway.bind("main");
	const reviewer = await gateway.bind("reviewer");
	const sourceReader = await gateway.bind("source-reader");
	const sourceExtractor = await gateway.bind("source-extractor");
	assert.equal(agent.snapshot.model, "agent-model");
	assert.equal(reviewer.snapshot.model, "reviewer-model");
	assert.equal(sourceReader.snapshot.model, "agent-model");
	assert.equal(sourceExtractor.snapshot.model, "agent-model");
	assert.equal(agent.snapshot.routingVersion, reviewer.snapshot.routingVersion);
	assert.match(agent.snapshot.routingVersion, /^sha256:[a-f0-9]{64}$/);
	assert.equal("apiKey" in agent.snapshot.options, false);
	assert.equal(Object.isFrozen(agent.snapshot), true);
	assert.equal(Object.isFrozen(agent.snapshot.options), true);

	const agentResult = await agent
		.stream({ messages: [{ role: "user", content: "修改 Design", timestamp: 1 }] })
		.result();
	const reviewerResult = await reviewer
		.stream({ messages: [{ role: "user", content: "审查候选", timestamp: 2 }] })
		.result();
	const sourceReaderResult = await sourceReader
		.stream({ messages: [{ role: "user", content: "读取 Source", timestamp: 3 }] })
		.result();
	const sourceExtractorResult = await sourceExtractor
		.stream({ messages: [{ role: "user", content: "抽取 Source", timestamp: 4 }] })
		.result();
	assert.equal(agentResult.content[0]?.type, "text");
	assert.equal(agentResult.content[0]?.type === "text" ? agentResult.content[0].text : undefined, "agent result");
	assert.equal(
		reviewerResult.content[0]?.type === "text" ? reviewerResult.content[0].text : undefined,
		"reviewer result",
	);
	assert.equal(
		sourceReaderResult.content[0]?.type === "text" ? sourceReaderResult.content[0].text : undefined,
		"source reader result",
	);
	assert.equal(
		sourceExtractorResult.content[0]?.type === "text" ? sourceExtractorResult.content[0].text : undefined,
		"source extractor result",
	);
	assert.equal(faux.state.callCount, 4);
});

test("Model Gateway 为每次 streaming 调用记录脱敏模型 span", async () => {
	const faux = fauxProvider({ provider: "suiming-faux", models: [{ id: "agent-model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const telemetry = new InMemoryTelemetryContext();
	const gateway = new ModelGateway(models, routingConfig("suiming-faux"), { telemetryContext: telemetry });
	const agent = await gateway.bind("main");
	faux.setResponses([fauxAssistantMessage("first result"), fauxAssistantMessage("second result")]);

	await agent.stream({ messages: [{ role: "user", content: "敏感正文", timestamp: 1 }] }).result();
	await agent.stream({ messages: [{ role: "user", content: "另一段敏感正文", timestamp: 2 }] }).result();

	const spans = telemetry.getSpans();
	assert.equal(spans.length, 2);
	for (const span of spans) {
		assert.equal(span.name, "suiming.model.call");
		assert.equal(span.attributes["gen_ai.provider.name"], "suiming-faux");
		assert.equal(span.attributes["gen_ai.request.model"], "agent-model");
		assert.equal(span.attributes["gen_ai.response.model"], "agent-model");
		assert.equal(span.attributes["suiming.model.profile_id"], "main");
		assert.equal(span.attributes["suiming.model.stop_reason"], "stop");
		assert.equal(Object.values(span.attributes).includes("敏感正文"), false);
		assert.equal(Object.values(span.attributes).includes("另一段敏感正文"), false);
		assert.deepEqual(span.status, { status: "ok" });
	}
});

test("Model Gateway 拒绝未知模型、密钥和请求生命周期配置", async () => {
	const faux = fauxProvider({ provider: "suiming-faux", models: [{ id: "agent-model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const unknownGateway = new ModelGateway(models, routingConfig("suiming-faux"));
	await assert.rejects(
		() => unknownGateway.bind("reviewer"),
		(error: unknown) => error instanceof ModelGatewayError && error.code === "model_not_found",
	);

	assert.throws(
		() =>
			new ModelGateway(models, {
				profiles: {
					main: {
						provider: "suiming-faux",
						model: "agent-model",
						options: { apiKey: "must-not-enter-profile" },
					},
					reviewer: { provider: "suiming-faux", model: "agent-model" },
				},
			}),
		(error: unknown) => error instanceof ModelGatewayError && error.code === "unsafe_model_options",
	);
});

test("profile options 在 bind 时按模型 API 的选项 schema 校验，写错键名不再被静默忽略", async () => {
	const faux = fauxProvider({
		provider: "suiming-faux-openai",
		api: "openai-completions",
		models: [{ id: "agent-model" }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	const gateway = (options: ModelProfileOptions) =>
		new ModelGateway(models, {
			profiles: {
				main: { provider: "suiming-faux-openai", model: "agent-model", options },
				reviewer: { provider: "suiming-faux-openai", model: "agent-model" },
			},
		});
	const bound = await gateway({ maxTokens: 65536, reasoningEffort: "high", samplingParams: { top_p: 0.9 } }).bind(
		"main",
	);
	assert.deepEqual(bound.snapshot.options, {
		maxTokens: 65536,
		reasoningEffort: "high",
		samplingParams: { top_p: 0.9 },
	});
	// R0 的真实事故：streamSimple 的 reasoning 不是 openai-completions 的键，以前会静默变成 thinking: disabled。
	await assert.rejects(
		() => gateway({ reasoning: "high" }).bind("main"),
		(error: unknown) =>
			error instanceof ModelGatewayError &&
			error.code === "invalid_model_options" &&
			error.message.includes("reasoningEffort"),
	);
	await assert.rejects(
		() => gateway({ reasoningEffort: "extreme" }).bind("main"),
		(error: unknown) => error instanceof ModelGatewayError && error.code === "invalid_model_options",
	);
	await assert.rejects(
		() => gateway({ toolChoice: "none" }).bind("main"),
		(error: unknown) => error instanceof ModelGatewayError && error.code === "invalid_model_options",
	);
	// 未知 API 无法校验，只能放行。
	const custom = fauxProvider({ provider: "suiming-faux-custom", models: [{ id: "agent-model" }] });
	models.setProvider(custom.provider);
	const passthrough = await new ModelGateway(models, {
		profiles: {
			main: { provider: "suiming-faux-custom", model: "agent-model", options: { anything: 1 } },
			reviewer: { provider: "suiming-faux-custom", model: "agent-model" },
		},
	}).bind("main");
	assert.deepEqual(passthrough.snapshot.options, { anything: 1 });
});

test("Model Gateway 在创建模型调用前检查 provider 凭据", async () => {
	const faux = fauxProvider({ provider: "no-credentials", models: [{ id: "agent-model" }] });
	const models = createModels();
	models.setProvider({
		...faux.provider,
		auth: {
			apiKey: {
				name: "Missing credentials",
				resolve: async () => undefined,
			},
		},
	});
	const gateway = new ModelGateway(models, {
		profiles: {
			main: { provider: "no-credentials", model: "agent-model" },
			reviewer: { provider: "no-credentials", model: "agent-model" },
		},
	});

	await assert.rejects(
		() => gateway.bind("main"),
		(error: unknown) => error instanceof ModelGatewayError && error.code === "model_credentials_missing",
	);
	assert.equal(faux.state.callCount, 0);
});

test("订阅计划凭据按 provider 实际能力绑定，不施加统一 automation 禁止", async () => {
	const faux = fauxProvider({ provider: "qwen-token-plan-cn", models: [{ id: "agent-model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const gateway = new ModelGateway(models, {
		profiles: {
			main: { provider: "qwen-token-plan-cn", model: "agent-model" },
			reviewer: { provider: "qwen-token-plan-cn", model: "agent-model" },
		},
	});
	const bound = await gateway.bind("main");
	assert.equal(bound.snapshot.credentialType, "api_key");
	assert.equal("credentialUse" in bound.snapshot, false);
});

test("模型观测保留互斥缓存用量和实际费用，不发送正文", async () => {
	const { traceModelCall } = await import("../src/model/model-call-telemetry.js");
	const faux = fauxProvider({ provider: "suiming-faux", models: [{ id: "agent-model" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bound = await new ModelGateway(models, routingConfig("suiming-faux")).bind("main");
	const telemetry = new InMemoryTelemetryContext();
	await traceModelCall(telemetry, bound.snapshot, async () => ({
		...fauxAssistantMessage("private output"),
		usage: {
			input: 100,
			output: 20,
			cacheRead: 40,
			cacheWrite: 10,
			totalTokens: 170,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0004, cacheWrite: 0.0001, total: 0.0035 },
		},
	}));
	const attrs = telemetry.getSpans()[0]?.attributes;
	assert.equal(attrs?.["gen_ai.usage.input_tokens"], 150);
	assert.deepEqual(JSON.parse(String(attrs?.["langfuse.observation.usage_details"])), {
		input: 100,
		output: 20,
		input_cache_read: 40,
		input_cache_write: 10,
		total: 170,
	});
	assert.equal(attrs?.["gen_ai.usage.cost"], 0.0035);
	assert.ok(!JSON.stringify(attrs).includes("private output"));
});
