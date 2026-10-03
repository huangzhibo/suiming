import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthContext, AuthEvent, AuthPrompt, AuthType, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { LocalCommandInput, LocalCommandOutput } from "@suiming/sdk";
import { parse, stringify } from "smol-toml";
import { MODEL_PROFILE_IDS, MODEL_PROFILE_LABELS, type ModelProfileId } from "./config.js";
import { ModelGatewayError } from "./errors.js";
import { JsonFileCredentialStore } from "./json-file-credential-store.js";
import { validateProfileOptions } from "./model-options-schema.js";
import { configuredThinking, thinkingLevels, withThinking } from "./thinking-options.js";
import { loadModelRoutingConfig, parseModelRoutingToml } from "./user-config.js";

type ShowOutput = LocalCommandOutput<"models.show">;
type LoginStatus = LocalCommandOutput<"models.login.status">;
type LoginEvent = LoginStatus["events"][number];
type LoginPrompt = NonNullable<LoginStatus["prompt"]>;

export interface LocalModelSettingsOptions {
	configPath?: string;
	credentials?: JsonFileCredentialStore;
	/** 测试注入自定义 provider；默认是 pi-ai 内建目录。必须与 credentials 共用同一个凭据存储。 */
	models?: Models;
	authContext?: AuthContext;
	/** 登录流程给出授权 URL 时打开系统浏览器；pi-ai 自己不开浏览器，桌面主进程用 shell.openExternal。 */
	openUrl?: (url: string) => Promise<void>;
}

/**
 * 一次 provider 登录：pi-ai 的 login 是 prompt / notify 回调式交互，这里把它摊成可轮询的状态，
 * 窗口读 status、答 prompt；主进程持有真实流程与 AbortController。
 */
class LoginSession {
	readonly id = randomUUID();
	readonly provider: string;
	status: LoginStatus["status"] = "pending";
	readonly events: LoginEvent[] = [];
	error: string | undefined;
	readonly #abort = new AbortController();
	#prompt: { view: LoginPrompt; resolve(value: string): void; reject(error: Error): void } | undefined;

	constructor(provider: string) {
		this.provider = provider;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	prompt(request: AuthPrompt): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const settle = (fn: () => void) => {
				if (this.#prompt?.view.id !== view.id) return;
				this.#prompt = undefined;
				request.signal?.removeEventListener("abort", onAbort);
				this.#abort.signal.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = () => settle(() => reject(new Error("登录提示已取消")));
			const view: LoginPrompt = {
				id: randomUUID(),
				type: request.type,
				message: request.message,
				...(request.type === "select"
					? {
							options: request.options.map((option) => ({
								id: option.id,
								label: option.label,
								...(option.description === undefined ? {} : { description: option.description }),
							})),
						}
					: request.placeholder === undefined
						? {}
						: { placeholder: request.placeholder }),
			};
			this.#prompt = {
				view,
				resolve: (value) => settle(() => resolve(value)),
				reject: (error) => settle(() => reject(error)),
			};
			// pi-ai 会在带外事件（浏览器回调先到）时中止 manual_code 提示；整个会话取消也要收掉挂起的提示。
			request.signal?.addEventListener("abort", onAbort, { once: true });
			this.#abort.signal.addEventListener("abort", onAbort, { once: true });
			if (request.signal?.aborted || this.#abort.signal.aborted) onAbort();
		});
	}

	notify(event: AuthEvent): void {
		if (event.type === "info" || event.type === "progress") {
			this.events.push({ type: event.type, message: event.message });
		} else if (event.type === "auth_url") {
			this.events.push({
				type: "auth_url",
				url: event.url,
				...(event.instructions === undefined ? {} : { instructions: event.instructions }),
			});
		} else {
			this.events.push({
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: Math.round(event.expiresInSeconds) }),
			});
		}
	}

	reply(promptId: string, value: string): void {
		if (this.status !== "pending") throw new ModelGatewayError("login_already_finished", "这次登录已经结束");
		if (this.#prompt?.view.id !== promptId)
			throw new ModelGatewayError("login_prompt_stale", "这个提示已失效，请按最新提示回答");
		this.#prompt.resolve(value);
	}

	cancel(): void {
		if (this.status !== "pending") return;
		this.status = "cancelled";
		this.#abort.abort(new Error("作者取消登录"));
	}

	finish(error?: unknown): void {
		if (this.status !== "pending") return;
		if (error === undefined) this.status = "succeeded";
		else {
			this.status = "failed";
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	view(): LoginStatus {
		return {
			sessionId: this.id,
			provider: this.provider,
			status: this.status,
			events: [...this.events],
			...(this.#prompt === undefined || this.status !== "pending" ? {} : { prompt: this.#prompt.view }),
			...(this.error === undefined ? {} : { error: this.error }),
		};
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * 这个安装的固定 ID，存在凭据文件旁边的 `installation-id`，第一次用到时生成。Sign in with ChatGPT
 * 把它当 agent host 报给 OpenAI（`ext_agent_host_id = urn:uuid:<id>`），要求每次登录都是同一个；
 * pi-ai 经 `Models.login` 的 `getDeviceId` 向宿主要（它自己的命令行每次给一个新的随机值）。
 * 不是 secret，但标识这台机器上的安装，权限照凭据文件给 0600。
 */
function installationId(credentialPath: string): string {
	const path = join(dirname(credentialPath), "installation-id");
	const read = () => {
		try {
			const id = readFileSync(path, "utf8").trim();
			return UUID.test(id) ? id : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	};
	const existing = read();
	if (existing !== undefined) return existing;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const id = randomUUID();
	try {
		writeFileSync(path, `${id}\n`, { mode: 0o600, flag: "wx" });
		return id;
	} catch (error) {
		// 另一个进程刚写下：用它的，不覆盖。
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return read() ?? id;
		throw error;
	}
}

/** 主进程模型设置；凭据只经 provider 自己的登录流程写入 auth.json，查询结果里不含 secret。 */
export class LocalModelSettings {
	readonly configPath: string;
	readonly credentials: JsonFileCredentialStore;
	readonly #models: Models;
	readonly #openUrl: ((url: string) => Promise<void>) | undefined;
	readonly #sessions = new Map<string, LoginSession>();
	#chain: Promise<unknown> = Promise.resolve();
	constructor(options: LocalModelSettingsOptions = {}) {
		this.configPath =
			options.configPath ?? process.env.SUIMING_CONFIG_PATH ?? join(homedir(), ".suiming", "config.toml");
		this.credentials = options.credentials ?? new JsonFileCredentialStore();
		this.#models =
			options.models ??
			builtinModels({
				credentials: this.credentials,
				...(options.authContext === undefined ? {} : { authContext: options.authContext }),
			});
		this.#openUrl = options.openUrl;
	}

	async #usable(providerId: string): Promise<ShowOutput["providers"][number]["usable"]> {
		try {
			const check = await this.#models.checkAuth(providerId);
			return check === undefined ? null : { type: check.type, source: check.source ?? "provider" };
		} catch {
			// 单个 provider 的环境探测失败（例如 AWS 配置损坏）只影响它自己的状态，不拖垮整份设置。
			return null;
		}
	}

	async show(): Promise<ShowOutput> {
		const stored = await this.credentials.list();
		const disabled = parseModelRoutingToml(await this.#configSource()).disabledProviders ?? [];
		const providers = await Promise.all(
			this.#models.getProviders().map(async (provider): Promise<ShowOutput["providers"][number]> => {
				const apiKey = provider.auth.apiKey;
				const oauth = provider.auth.oauth;
				return {
					id: provider.id,
					enabled: !disabled.includes(provider.id),
					name: provider.name,
					apiKey: apiKey === undefined ? null : { name: apiKey.name, login: apiKey.login !== undefined },
					oauth: oauth === undefined ? null : { name: oauth.name, subscription: oauth.isSubscription ?? false },
					stored: stored.find((account) => account.providerId === provider.id)?.type ?? "none",
					usable: await this.#usable(provider.id),
					models: provider
						.getModels()
						.map((model) => ({ id: model.id, name: model.name, thinkingLevels: thinkingLevels(model) })),
				};
			}),
		);
		let profiles: ShowOutput["profiles"] = MODEL_PROFILE_IDS.map((id) => ({
			id,
			...MODEL_PROFILE_LABELS[id],
			provider: "",
			model: "",
			options: "{}",
			source: "default-empty",
			state: "unconfigured",
			detail: `「${MODEL_PROFILE_LABELS[id].label}」还没有配置模型`,
		}));
		try {
			const loaded = await loadModelRoutingConfig({ configPath: this.configPath });
			profiles = MODEL_PROFILE_IDS.map((id) => {
				const profile = loaded.config.profiles[id] ?? loaded.config.profiles.main;
				const provider = providers.find((item) => item.id === profile.provider);
				const definition = this.#models.getModel(profile.provider, profile.model);
				const thinking =
					profile.thinking ?? (definition ? configuredThinking(definition, profile.options) : undefined);
				const state = this.#profileState(id, profile.provider, profile.model, provider);
				return {
					id,
					...MODEL_PROFILE_LABELS[id],
					provider: profile.provider,
					model: profile.model,
					options: JSON.stringify(profile.options ?? {}),
					...(thinking === undefined ? {} : { thinking }),
					source: loaded.diagnostic.profiles[id].providerSource,
					...state,
				};
			});
		} catch (error) {
			if (
				!(error instanceof ModelGatewayError) ||
				!["missing_model_config", "model_config_not_found"].includes(error.code)
			)
				throw error;
		}
		return { profiles, providers };
	}

	#profileState(
		id: ModelProfileId,
		providerId: string,
		modelId: string,
		provider: ShowOutput["providers"][number] | undefined,
	): Pick<ShowOutput["profiles"][number], "state" | "detail"> {
		if (provider === undefined || !provider.models.some((model) => model.id === modelId))
			return {
				state: "unknown_model",
				detail: `「${MODEL_PROFILE_LABELS[id].label}」配置的 ${providerId}/${modelId} 不在模型目录里，请重新选择`,
			};
		if (!provider.enabled)
			return { state: "provider_disabled", detail: `${provider.name} 已停用，启用后可继续使用此配置` };
		if (provider.usable === null) {
			const how =
				provider.oauth !== null && provider.apiKey?.login
					? `登录 ${provider.oauth.name} 或输入 API key`
					: provider.oauth !== null
						? `登录 ${provider.oauth.name}`
						: provider.apiKey?.login
							? "输入 API key"
							: "在环境里提供凭据";
			return { state: "missing_credentials", detail: `${provider.name} 还没有可用凭据，请${how}` };
		}
		return { state: "ready", detail: `凭据来源：${provider.usable.source}` };
	}

	save(input: LocalCommandInput<"models.save">): Promise<void> {
		const write = async () => {
			if (!MODEL_PROFILE_IDS.includes(input.profile))
				throw new ModelGatewayError("invalid_model_config", "未知 model profile");
			const model = this.#models.getModel(input.provider, input.model);
			if (!model) throw new ModelGatewayError("model_not_found", `${input.provider}/${input.model}`);
			const source = await this.#configSource();
			parseModelRoutingToml(source);
			const document = parse(source);
			document.models ??= {};
			const configured = document.models as Record<string, unknown>;
			configured.profiles ??= {};
			const profiles = configured.profiles as Record<string, unknown>;
			let options: unknown;
			try {
				options = JSON.parse(input.options ?? "{}");
			} catch {
				throw new ModelGatewayError("invalid_model_options", "模型参数需要 JSON object");
			}
			if (!options || typeof options !== "object" || Array.isArray(options))
				throw new ModelGatewayError("invalid_model_options", "模型参数需要 JSON object");
			const previous = profiles[input.profile] as import("./config.js").ModelProfileConfig | undefined;
			const thinking =
				input.thinking ??
				(previous?.provider === input.provider && previous?.model === input.model ? previous.thinking : undefined);
			validateProfileOptions(
				model.api,
				withThinking(model, options as import("./config.js").ModelProfileOptions, thinking),
				`profiles.${input.profile}.options`,
			);
			// 标准档位单独保存；不从有损的 API 参数反推作者选择。
			if (thinking !== undefined)
				options = withThinking(model, options as import("./config.js").ModelProfileOptions, "default");
			profiles[input.profile] = {
				provider: input.provider,
				model: input.model,
				options,
				...(thinking === undefined ? {} : { thinking }),
			};
			await this.#writeConfig(document);
		};
		const result = this.#chain.then(write, write);
		this.#chain = result.catch(() => undefined);
		return result;
	}

	async #configSource(): Promise<string> {
		try {
			return await readFile(this.configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return "version = 1\n";
		}
	}

	async #writeConfig(document: Parameters<typeof stringify>[0]): Promise<void> {
		const next = stringify(document);
		parseModelRoutingToml(next);
		const temporary = join(dirname(this.configPath), `.config-${randomUUID()}.tmp`);
		await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
		try {
			await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
			await rename(temporary, this.configPath);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	setProviderEnabled(input: LocalCommandInput<"models.provider.setEnabled">): Promise<void> {
		const write = async () => {
			if (!this.#models.getProvider(input.provider))
				throw new ModelGatewayError("model_not_found", `未知 provider ${input.provider}`);
			const source = await this.#configSource();
			const disabled = new Set(parseModelRoutingToml(source).disabledProviders ?? []);
			if (input.enabled) disabled.delete(input.provider);
			else disabled.add(input.provider);
			const document = parse(source);
			document.models ??= {};
			(document.models as Record<string, unknown>).disabled_providers = [...disabled].sort();
			await this.#writeConfig(document);
		};
		const result = this.#chain.then(write, write);
		this.#chain = result.catch(() => undefined);
		return result;
	}

	/** 同一时刻只有一次登录在进行；新开一次会取消上一次，已结束的会话保留到下次开始，窗口还能读到结果。 */
	startLogin(input: LocalCommandInput<"models.login.start">): LocalCommandOutput<"models.login.start"> {
		const provider = this.#models.getProvider(input.provider);
		if (provider === undefined) throw new ModelGatewayError("model_not_found", `未知 provider ${input.provider}`);
		const method = input.type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (method?.login === undefined)
			throw new ModelGatewayError(
				"unsupported_login",
				input.type === "oauth"
					? `${provider.name} 不支持 OAuth 登录`
					: `${provider.name} 只认环境里的凭据，没有输入入口`,
			);
		for (const session of this.#sessions.values()) session.cancel();
		this.#sessions.clear();
		const session = new LoginSession(provider.id);
		this.#sessions.set(session.id, session);
		void this.#models
			.login(
				provider.id,
				input.type as AuthType,
				{
					signal: session.signal,
					prompt: (request) => session.prompt(request),
					notify: (event) => {
						session.notify(event);
						const url =
							event.type === "auth_url" ? event.url : event.type === "device_code" ? event.verificationUri : "";
						if (url && this.#openUrl !== undefined && /^https?:\/\//u.test(url))
							void this.#openUrl(url).catch((error: unknown) => {
								session.notify({
									type: "info",
									message: `没能自动打开浏览器（${error instanceof Error ? error.message : String(error)}），请手动打开上面的链接`,
								});
							});
					},
				},
				{ getDeviceId: () => installationId(this.credentials.path) },
			)
			.then(
				() => session.finish(),
				(error: unknown) => session.finish(error),
			);
		return { sessionId: session.id };
	}

	loginStatus(input: LocalCommandInput<"models.login.status">): LoginStatus {
		return this.#session(input.sessionId).view();
	}

	replyLogin(input: LocalCommandInput<"models.login.reply">): void {
		this.#session(input.sessionId).reply(input.promptId, input.value);
	}

	cancelLogin(input: LocalCommandInput<"models.login.cancel">): void {
		this.#session(input.sessionId).cancel();
	}

	#session(id: string): LoginSession {
		const session = this.#sessions.get(id);
		if (session === undefined)
			throw new ModelGatewayError("login_session_not_found", "登录会话不存在或已被新的登录替代");
		return session;
	}

	async disconnect(input: LocalCommandInput<"models.disconnect">): Promise<void> {
		await this.#models.logout(input.provider);
	}
}
