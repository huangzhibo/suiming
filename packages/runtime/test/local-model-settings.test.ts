import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AuthContext, createModels, fauxProvider, type OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { USAGE_CHECKPOINT_TOKENS } from "@suiming/sdk";
import { JsonFileCredentialStore } from "../src/model/json-file-credential-store.js";
import { LocalModelSettings } from "../src/model/local-model-settings.js";
import { ModelGateway } from "../src/model/model-gateway.js";
import { loadModelRoutingConfig, loadUsageCheckpoint, parseModelRoutingToml } from "../src/model/user-config.js";

const authContext = (env: Record<string, string>): AuthContext => ({
	env: async (name) => env[name],
	fileExists: async () => false,
});

async function settled(settings: LocalModelSettings, sessionId: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const status = settings.loginStatus({ sessionId });
		if (status.status !== "pending") return status;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("登录会话没有结束");
}

async function prompted(settings: LocalModelSettings, sessionId: string) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const status = settings.loginStatus({ sessionId });
		if (status.status !== "pending") assert.fail(`登录已结束：${status.status} ${status.error ?? ""}`);
		if (status.prompt) return status.prompt;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("登录会话没有给出提示");
}

test("桌面模型设置：profile 状态按 provider 凭据探测报告，API key 经 provider 登录流程写入，查询不返回凭据", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-model-settings-"));
	try {
		const configPath = join(root, "config.toml");
		await writeFile(configPath, 'version = 1\n[cloud]\nendpoint = "https://example.test"\n');
		const credentials = new JsonFileCredentialStore({ path: join(root, "auth.json") });
		const settings = new LocalModelSettings({
			configPath,
			credentials,
			authContext: authContext({ DEEPSEEK_API_KEY: "env-key-never-returned" }),
		});
		const catalog = await settings.show();
		assert.equal(catalog.profiles.find((profile) => profile.id === "main")?.state, "unconfigured");
		const deepseek = catalog.providers.find((provider) => provider.id === "deepseek") ?? assert.fail("缺少 deepseek");
		assert.deepEqual(deepseek.usable, { type: "api_key", source: "DEEPSEEK_API_KEY" });
		assert.equal(deepseek.stored, "none");
		const codex = catalog.providers.find((provider) => provider.id === "openai-codex") ?? assert.fail("缺少 codex");
		assert.equal(codex.usable, null);
		assert.equal(codex.oauth?.subscription, true);
		const codexModel = codex.models[0]?.id ?? assert.fail("codex 缺少模型");

		// 选了没有凭据的 provider：状态点名 provider 和该怎么连。
		await settings.save({ profile: "main", provider: codex.id, model: codexModel, options: "{}" });
		let agent = (await settings.show()).profiles.find((profile) => profile.id === "main");
		assert.equal(agent?.state, "missing_credentials");
		assert.match(agent?.detail ?? "", /登录 OpenAI \(ChatGPT Plus\/Pro\)/);

		// 环境变量提供的凭据也算可用；保存保留其他配置段并保持 0600。
		const deepseekModel = deepseek.models[0]?.id ?? assert.fail("deepseek 缺少模型");
		await settings.save({ profile: "main", provider: deepseek.id, model: deepseekModel, options: "{}" });
		agent = (await settings.show()).profiles.find((profile) => profile.id === "main");
		assert.equal(agent?.state, "ready");
		assert.match(agent?.detail ?? "", /DEEPSEEK_API_KEY/);
		const source = await readFile(configPath, "utf8");
		assert.match(source, /example.test/);
		assert.ok(parseModelRoutingToml(source));
		assert.equal((await stat(configPath)).mode & 0o077, 0);
		await assert.rejects(
			settings.save({ profile: "main", provider: deepseek.id, model: deepseekModel, options: "invalid json" }),
			{ code: "invalid_model_options" },
		);
		assert.equal(await readFile(configPath, "utf8"), source);

		// 开关独立于环境/本地凭据；拒绝新绑定，但已冻结在 turn 里的绑定仍可恢复。
		const models = builtinModels({
			credentials,
			authContext: authContext({ DEEPSEEK_API_KEY: "env-key-never-returned" }),
		});
		const gateway = async () =>
			new ModelGateway(models, (await loadModelRoutingConfig({ configPath, environment: {} })).config);
		const frozen = (await (await gateway()).bind("main")).snapshot;
		await settings.setProviderEnabled({ provider: deepseek.id, enabled: false });
		const disabledView = await settings.show();
		assert.equal(disabledView.providers.find((item) => item.id === deepseek.id)?.enabled, false);
		assert.ok(disabledView.providers.find((item) => item.id === deepseek.id)?.usable, "停用不删除环境凭据状态");
		assert.equal(disabledView.profiles.find((item) => item.id === "main")?.state, "provider_disabled");
		const disabledGateway = await gateway();
		await assert.rejects(disabledGateway.bind("main"), { code: "model_provider_disabled" });
		await assert.rejects(disabledGateway.bind("main", { provider: deepseek.id, model: deepseekModel }), {
			code: "model_provider_disabled",
		});
		assert.equal((await disabledGateway.bindFrozen(frozen)).snapshot.model, frozen.model);
		const reopened = new LocalModelSettings({ configPath, credentials, models });
		assert.equal((await reopened.show()).providers.find((item) => item.id === deepseek.id)?.enabled, false);
		await reopened.setProviderEnabled({ provider: deepseek.id, enabled: true });
		assert.equal((await (await gateway()).bind("main")).snapshot.model, deepseekModel);
		await assert.rejects(settings.setProviderEnabled({ provider: "missing-provider", enabled: false }), {
			code: "model_not_found",
		});

		// 配置文件手写了目录里没有的模型：不报错，标为 unknown_model。
		await writeFile(configPath, `${source}\n[models.profiles.writer]\nprovider = "deepseek"\nmodel = "ghost"\n`);
		const writer = (await settings.show()).profiles.find((profile) => profile.id === "writer");
		assert.equal(writer?.state, "unknown_model");
		assert.match(writer?.detail ?? "", /deepseek\/ghost/);
		// profile 的中文名只有一张表：设置页显示的名字就是报错里点的那个名字（原来一边「正文写作」一边「Writer」）。
		assert.equal(writer?.label, "正文写作");
		assert.ok(writer?.detail.includes(`「${writer.label}」`), writer?.detail);
		assert.ok(writer?.description);

		// API key 登录：provider 自己的 login 提示输入 secret，回答后凭据落到 auth.json。
		const moonshot =
			catalog.providers.find((provider) => provider.id === "moonshotai") ?? assert.fail("缺少 moonshotai");
		assert.equal(moonshot.apiKey?.login, true);
		const { sessionId } = settings.startLogin({ provider: moonshot.id, type: "api_key" });
		const prompt = await prompted(settings, sessionId);
		assert.equal(prompt.type, "secret");
		settings.replyLogin({ sessionId, promptId: prompt.id, value: "test-key-never-returned" });
		assert.equal((await settled(settings, sessionId)).status, "succeeded");
		assert.throws(() => settings.replyLogin({ sessionId, promptId: prompt.id, value: "again" }), {
			code: "login_already_finished",
		});
		const exposed = await settings.show();
		const connected = exposed.providers.find((item) => item.id === moonshot.id);
		assert.equal(connected?.stored, "api_key");
		assert.deepEqual(connected?.usable, { type: "api_key", source: "stored credential" });
		assert.equal(JSON.stringify(exposed).includes("never-returned"), false);
		assert.equal((await stat(join(root, "auth.json"))).mode & 0o077, 0);

		const credentialBefore = await readFile(join(root, "auth.json"), "utf8");
		await settings.setProviderEnabled({ provider: moonshot.id, enabled: false });
		assert.equal((await settings.show()).providers.find((item) => item.id === moonshot.id)?.enabled, false);
		assert.equal(await readFile(join(root, "auth.json"), "utf8"), credentialBefore);
		await settings.setProviderEnabled({ provider: moonshot.id, enabled: true });
		assert.equal((await settings.show()).providers.find((item) => item.id === moonshot.id)?.usable?.type, "api_key");

		// 取消：不写任何凭据；过期提示不能再回答。
		const cancelled = settings.startLogin({ provider: "openai", type: "api_key" });
		const pending = await prompted(settings, cancelled.sessionId);
		settings.cancelLogin({ sessionId: cancelled.sessionId });
		assert.equal((await settled(settings, cancelled.sessionId)).status, "cancelled");
		assert.throws(() => settings.replyLogin({ sessionId: cancelled.sessionId, promptId: pending.id, value: "x" }), {
			code: "login_already_finished",
		});
		assert.equal((await settings.show()).providers.find((item) => item.id === "openai")?.stored, "none");
		// pi-ai 0.99 给 openai 加了 ChatGPT 订阅 OAuth；不支持 OAuth 的例子换成只认 API key 的 deepseek。
		assert.throws(() => settings.startLogin({ provider: "deepseek", type: "oauth" }), { code: "unsupported_login" });
		assert.throws(() => settings.loginStatus({ sessionId: "missing" }), { code: "login_session_not_found" });

		// 断开只删本地凭据。
		await settings.disconnect({ provider: moonshot.id });
		assert.equal((await settings.show()).providers.find((item) => item.id === moonshot.id)?.stored, "none");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("OAuth 登录：授权链接交给 openUrl，多轮提示与回答经会话转述，失败原因与取消都能读到", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-model-oauth-"));
	try {
		const credentials = new JsonFileCredentialStore({ path: join(root, "auth.json") });
		const faux = fauxProvider({ provider: "fake-oauth" });
		const models = createModels({ credentials });
		models.setProvider({
			...faux.provider,
			id: "fake-oauth",
			name: "Fake",
			auth: {
				oauth: {
					name: "Fake (Pro)",
					isSubscription: true,
					async login(interaction) {
						interaction.notify({ type: "auth_url", url: "https://example.test/auth", instructions: "去浏览器" });
						const method = await interaction.prompt({
							type: "select",
							message: "选择登录方式",
							options: [
								{ id: "browser", label: "浏览器" },
								{ id: "device", label: "设备码" },
							],
						});
						if (method === "device") {
							interaction.notify({
								type: "device_code",
								userCode: "ABCD-1234",
								verificationUri: "https://example.test/device",
								expiresInSeconds: 900,
							});
						}
						interaction.notify({ type: "progress", message: "等待授权码" });
						const code = await interaction.prompt({
							type: "manual_code",
							message: "粘贴授权码",
							placeholder: "code",
						});
						if (code !== "code-123") throw new Error("授权码无效");
						const credential: OAuthCredential = {
							type: "oauth",
							access: "access-never-returned",
							refresh: "refresh-never-returned",
							expires: Date.now() + 3_600_000,
						};
						return credential;
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		const opened: string[] = [];
		let failOpen = false;
		const settings = new LocalModelSettings({
			configPath: join(root, "config.toml"),
			credentials,
			models,
			openUrl: async (url) => {
				if (failOpen) throw new Error("no browser");
				opened.push(url);
			},
		});
		const shown = await settings.show();
		const provider = shown.providers.find((item) => item.id === "fake-oauth") ?? assert.fail("缺少 fake-oauth");
		assert.deepEqual(provider.oauth, { name: "Fake (Pro)", subscription: true });
		assert.equal(provider.usable, null);

		const first = settings.startLogin({ provider: "fake-oauth", type: "oauth" });
		const method = await prompted(settings, first.sessionId);
		assert.equal(method.type, "select");
		assert.deepEqual(
			method.options?.map((option) => option.id),
			["browser", "device"],
		);
		assert.deepEqual(opened, ["https://example.test/auth"]);
		settings.replyLogin({ sessionId: first.sessionId, promptId: method.id, value: "device" });
		const code = await prompted(settings, first.sessionId);
		assert.equal(code.type, "manual_code");
		assert.equal(code.placeholder, "code");
		assert.deepEqual(opened, ["https://example.test/auth", "https://example.test/device"]);
		assert.throws(() => settings.replyLogin({ sessionId: first.sessionId, promptId: method.id, value: "late" }), {
			code: "login_prompt_stale",
		});
		settings.replyLogin({ sessionId: first.sessionId, promptId: code.id, value: "code-123" });
		const done = await settled(settings, first.sessionId);
		assert.equal(done.status, "succeeded");
		assert.deepEqual(
			done.events.map((event) => event.type),
			["auth_url", "device_code", "progress"],
		);
		assert.equal(JSON.stringify(done).includes("never-returned"), false);
		const connected = (await settings.show()).providers.find((item) => item.id === "fake-oauth");
		assert.equal(connected?.stored, "oauth");
		assert.equal(connected?.usable?.type, "oauth");

		// 失败：provider 抛出的原因原样可读；开浏览器失败只追加一条说明。
		failOpen = true;
		const second = settings.startLogin({ provider: "fake-oauth", type: "oauth" });
		const again = await prompted(settings, second.sessionId);
		settings.replyLogin({ sessionId: second.sessionId, promptId: again.id, value: "browser" });
		const paste = await prompted(settings, second.sessionId);
		settings.replyLogin({ sessionId: second.sessionId, promptId: paste.id, value: "wrong" });
		const failed = await settled(settings, second.sessionId);
		assert.equal(failed.status, "failed");
		assert.equal(failed.error, "授权码无效");
		assert.ok(failed.events.some((event) => event.type === "info" && /没能自动打开浏览器/.test(event.message)));

		// 新开一次登录会取消并替换上一次；同一时刻只有一次登录在进行。
		const third = settings.startLogin({ provider: "fake-oauth", type: "oauth" });
		await prompted(settings, third.sessionId);
		const fourth = settings.startLogin({ provider: "fake-oauth", type: "oauth" });
		assert.throws(() => settings.loginStatus({ sessionId: third.sessionId }), { code: "login_session_not_found" });
		settings.cancelLogin({ sessionId: fourth.sessionId });
		assert.equal((await settled(settings, fourth.sessionId)).status, "cancelled");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Sign in with ChatGPT 要一个固定的安装 ID：第一次登录时生成并存在凭据旁边，之后每次登录都是同一个", async () => {
	// 2026-10-02 作者在设置页登录 OpenAI（ChatGPT 订阅），pi-ai 报「requires a device ID (UUID) for this
	// installation」：它把安装 ID 当 agent host 报给 OpenAI，要宿主应用经 Models.login 的第四个参数提供。
	const root = await mkdtemp(join(tmpdir(), "suiming-model-device-"));
	try {
		const credentials = new JsonFileCredentialStore({ path: join(root, "auth.json") });
		const seen: string[] = [];
		const faux = fauxProvider({ provider: "fake-agent-host" });
		const models = createModels({ credentials });
		models.setProvider({
			...faux.provider,
			id: "fake-agent-host",
			name: "Fake",
			auth: {
				oauth: {
					name: "Fake (ChatGPT)",
					isSubscription: true,
					async login(_interaction, options) {
						seen.push(options?.getDeviceId?.() ?? "missing");
						return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		});
		const login = async () => {
			const settings = new LocalModelSettings({ configPath: join(root, "config.toml"), credentials, models });
			const { sessionId } = settings.startLogin({ provider: "fake-agent-host", type: "oauth" });
			assert.equal((await settled(settings, sessionId)).status, "succeeded");
		};
		await login();
		await login();
		assert.match(seen[0] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
		assert.equal(seen[1], seen[0], "重开设置也是同一个 ID");
		assert.equal((await readFile(join(root, "installation-id"), "utf8")).trim(), seen[0]);
		assert.equal((await stat(join(root, "installation-id"))).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("每轮用量检查点：设置页读写 config.toml 的 session.usage_checkpoint，等于默认值时删掉这一项；换算用默认模型的输入单价", async () => {
	const root = await mkdtemp(join(tmpdir(), "suiming-usage-checkpoint-"));
	try {
		const configPath = join(root, "config.toml");
		await writeFile(configPath, 'version = 1\n[cloud]\nendpoint = "https://example.test"\n');
		const settings = new LocalModelSettings({
			configPath,
			credentials: new JsonFileCredentialStore({ path: join(root, "auth.json") }),
			authContext: authContext({ DEEPSEEK_API_KEY: "env-key" }),
		});
		assert.deepEqual((await settings.show()).usageCheckpoint, {
			tokens: USAGE_CHECKPOINT_TOKENS.default,
			mainInputPrice: null,
		});
		await settings.save({ profile: "main", provider: "deepseek", model: "deepseek-flash", options: "{}" });
		const price = (await settings.show()).usageCheckpoint.mainInputPrice;
		assert.ok(price !== null && price > 0, "默认模型在目录里有单价，设置页据此换算约合多少钱");

		await settings.saveUsageCheckpoint({ tokens: 20_000_000 });
		assert.equal((await settings.show()).usageCheckpoint.tokens, 20_000_000);
		assert.equal(await settings.usageCheckpoint(), 20_000_000);
		assert.equal(await loadUsageCheckpoint({ configPath }), 20_000_000, "CLI 读同一份配置");
		const written = await readFile(configPath, "utf8");
		assert.match(written, /\[session\]\s*\nusage_checkpoint = 20000000/u);
		assert.match(written, /endpoint = "https:\/\/example\.test"/u, "别的配置段保留");

		await settings.saveUsageCheckpoint({ tokens: USAGE_CHECKPOINT_TOKENS.default });
		assert.doesNotMatch(await readFile(configPath, "utf8"), /session|usage_checkpoint/u, "回到默认值就不写");
		assert.equal(await settings.usageCheckpoint(), USAGE_CHECKPOINT_TOKENS.default);
		assert.equal(
			await loadUsageCheckpoint({ configPath: join(root, "没有这个文件.toml") }),
			USAGE_CHECKPOINT_TOKENS.default,
		);

		assert.throws(() => parseModelRoutingToml("version = 1\n[session]\nusage_checkpoint = 100\n"), {
			code: "invalid_model_config_file",
			message: /session\.usage_checkpoint 须是 1000000 到 1000000000 之间的整数/u,
		});
		assert.throws(() => parseModelRoutingToml("version = 1\n[session]\nbudget = 1\n"), {
			code: "invalid_model_config_file",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
