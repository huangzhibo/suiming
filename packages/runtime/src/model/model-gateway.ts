import type { AuthType, Context, CredentialStore, Model, Models, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type AuthContext,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import type { ModelChoice } from "@suiming/sdk";
import { canonicalJson, sha256Hex } from "@suiming/story";
import type {
	ModelOptionValue,
	ModelProfileConfig,
	ModelProfileId,
	ModelProfileOptions,
	ModelRoutingConfig,
} from "./config.js";
import { MODEL_PROFILE_IDS, MODEL_PROFILE_LABELS } from "./config.js";
import { ModelGatewayError } from "./errors.js";
import { traceModelCall } from "./model-call-telemetry.js";
import { validateProfileOptions } from "./model-options-schema.js";
import { configuredThinking, withThinking } from "./thinking-options.js";

const FORBIDDEN_OPTION_KEYS = new Set([
	"apiKey",
	"env",
	"fetch",
	"headers",
	"onPayload",
	"onResponse",
	"signal",
	"telemetryContext",
]);

export interface ModelBindingSnapshot {
	modelProfileId: ModelProfileId;
	routingVersion: string;
	provider: string;
	model: string;
	api: string;
	baseUrl: string;
	credentialSource: string;
	credentialType: AuthType;
	options: ModelProfileOptions;
	thinking?: NonNullable<ModelChoice["thinking"]>;
}

export interface ModelCallRuntimeOptions {
	signal?: AbortSignal;
	telemetryContext?: TelemetryContext;
	/** 同一会话（或子任务）的请求共用一个 id：按会话做 prompt cache 路由的 provider 靠它命中前缀。 */
	sessionId?: string;
}

export interface BoundModelProfile {
	readonly snapshot: ModelBindingSnapshot;
	/** 绑定的 pi-ai Model；只供 SuimingHarness 计算用量与能力边界，不要绕过 stream / complete 自行调用。 */
	readonly model: Model<Api>;
	readonly telemetryContext: TelemetryContext;
	/** 唯一的调用入口；引擎内循环与所有观测都走它。需要整条消息时 `await stream(...).result()`。 */
	stream(context: Context, runtime?: ModelCallRuntimeOptions): AssistantMessageEventStream;
}

interface NormalizedModelRoutingConfig {
	disabledProviders?: readonly string[];
	profiles: Readonly<Record<ModelProfileId, ModelProfileConfig & { options: ModelProfileOptions }>>;
}

function requireNonempty(value: string, label: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new ModelGatewayError("invalid_model_config", `${label} must not be empty`);
	}
	return normalized;
}

function copyOptionValue(value: unknown, path: string, ancestors: WeakSet<object>): ModelOptionValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new ModelGatewayError("invalid_model_options", `${path} must be a finite number`);
		}
		return value;
	}
	if (typeof value !== "object") {
		throw new ModelGatewayError("invalid_model_options", `${path} must contain JSON-compatible values`);
	}
	if (ancestors.has(value)) {
		throw new ModelGatewayError("invalid_model_options", `${path} must not contain circular references`);
	}
	ancestors.add(value);
	if (Array.isArray(value)) {
		const result = value.map((item, index) => copyOptionValue(item, `${path}[${index}]`, ancestors));
		ancestors.delete(value);
		return Object.freeze(result);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new ModelGatewayError("invalid_model_options", `${path} must contain plain objects`);
	}
	const result: Record<string, ModelOptionValue> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = copyOptionValue(item, `${path}.${key}`, ancestors);
	}
	ancestors.delete(value);
	return Object.freeze(result);
}

function normalizeOptions(profileId: ModelProfileId, options: ModelProfileOptions | undefined): ModelProfileOptions {
	if (options === undefined) return Object.freeze({});
	for (const key of Object.keys(options)) {
		if (FORBIDDEN_OPTION_KEYS.has(key)) {
			throw new ModelGatewayError(
				"unsafe_model_options",
				`Model profile ${profileId} must not configure ${key}; credentials and request lifecycle state stay outside the profile`,
			);
		}
	}
	return copyOptionValue(options, `profiles.${profileId}.options`, new WeakSet()) as ModelProfileOptions;
}

function normalizeProfile(
	profileId: ModelProfileId,
	profile: ModelProfileConfig,
): ModelProfileConfig & {
	options: ModelProfileOptions;
} {
	return Object.freeze({
		provider: requireNonempty(profile.provider, `profiles.${profileId}.provider`),
		model: requireNonempty(profile.model, `profiles.${profileId}.model`),
		options: normalizeOptions(profileId, profile.options),
		...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
	});
}

function normalizeConfig(config: ModelRoutingConfig): NormalizedModelRoutingConfig {
	const profiles = Object.fromEntries(
		MODEL_PROFILE_IDS.map((profileId) => [
			profileId,
			normalizeProfile(profileId, config.profiles[profileId] ?? config.profiles.main),
		]),
	) as Record<ModelProfileId, ModelProfileConfig & { options: ModelProfileOptions }>;
	return Object.freeze({
		profiles: Object.freeze(profiles),
		...(config.disabledProviders?.length
			? { disabledProviders: Object.freeze([...new Set(config.disabledProviders)].sort()) }
			: {}),
	});
}

function routingVersion(config: NormalizedModelRoutingConfig): string {
	return `sha256:${sha256Hex(canonicalJson(config))}`;
}

function freezeSnapshot(snapshot: ModelBindingSnapshot): ModelBindingSnapshot {
	return Object.freeze({ ...snapshot, options: snapshot.options });
}

function callOptions(
	options: ModelProfileOptions,
	runtime: ModelCallRuntimeOptions | undefined,
	telemetryContext: TelemetryContext,
): ModelsApiStreamOptions<Api> {
	return {
		...options,
		...(runtime?.signal === undefined ? {} : { signal: runtime.signal }),
		...(runtime?.sessionId === undefined ? {} : { sessionId: runtime.sessionId }),
		telemetryContext: runtime?.telemetryContext ?? telemetryContext,
	} as ModelsApiStreamOptions<Api>;
}

/**
 * 流式调用也进入同一个 suiming.model.call span：把内层流的事件转发到外层流，span 在最终 AssistantMessage 到达时结束。
 * 引擎内循环只走 stream，所以这是模型调用观测的唯一入口。
 */
function tracedStream(
	telemetryContext: TelemetryContext,
	snapshot: ModelBindingSnapshot,
	open: (span: TelemetryContext) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	let terminal: AssistantMessageEvent | undefined;
	const syntheticError = (message: string): AssistantMessageEvent => ({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: snapshot.api as Api,
			provider: snapshot.provider,
			model: snapshot.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	});
	// 终止事件等 span 记录完 usage 与 stopReason 之后再转发，调用方 await result() 时 span 已经完整。
	void traceModelCall(telemetryContext, snapshot, async (span) => {
		const inner = open(span);
		let completionStarted = false;
		for await (const event of inner) {
			if (!completionStarted && ["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type)) {
				completionStarted = true;
				span.setAttributes({ "langfuse.observation.completion_start_time": new Date().toISOString() });
			}
			if (event.type === "done" || event.type === "error") {
				terminal = event;
				break;
			}
			outer.push(event);
		}
		if (terminal?.type === "done") return terminal.message;
		if (terminal?.type === "error") return terminal.error;
		return inner.result();
	}).then(
		(message) => {
			if (terminal !== undefined) outer.push(terminal);
			else outer.end(message);
		},
		(error: unknown) => {
			outer.push(syntheticError(error instanceof Error ? error.message : String(error)));
		},
	);
	return outer;
}

export interface ModelGatewayOptions {
	telemetryContext?: TelemetryContext;
}

export class ModelGateway {
	readonly #models: Models;
	readonly #config: NormalizedModelRoutingConfig;
	readonly #configured: ReadonlySet<string>;
	readonly #telemetryContext: TelemetryContext;
	readonly routingVersion: string;

	constructor(models: Models, config: ModelRoutingConfig, options: ModelGatewayOptions = {}) {
		this.#models = models;
		this.#configured = new Set(Object.keys(config.profiles));
		this.#config = normalizeConfig(config);
		this.#telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
		this.routingVersion = routingVersion(this.#config);
	}

	/**
	 * 这个角色委派时是否跟随对话的模型：`main` 就是对话本身，其它角色在配置里没单独设时也跟随。
	 * 2026-10-05 之前没配的角色回落到配置里的 main，作者给一段对话另选了模型，委派出去的子任务仍用默认模型。
	 */
	followsConversation(profileId: ModelProfileId): boolean {
		return profileId === "main" || !this.#configured.has(profileId);
	}

	async bind(profileId: ModelProfileId, choice?: ModelChoice): Promise<BoundModelProfile> {
		const configured = this.#config.profiles[profileId];
		const profile = choice
			? {
					...choice,
					options:
						configured.provider === choice.provider && configured.model === choice.model
							? configured.options
							: {},
				}
			: configured;
		if (this.#config.disabledProviders?.includes(profile.provider))
			throw new ModelGatewayError(
				"model_provider_disabled",
				`${profile.provider} 已停用，请在设置中启用，或选择其他提供商的模型`,
			);
		const model = this.#models.getModel(profile.provider, profile.model);
		if (model === undefined) {
			throw new ModelGatewayError(
				"model_not_found",
				`「${MODEL_PROFILE_LABELS[profileId].label}」使用的 ${profile.provider}/${profile.model} 不在模型目录中，请在设置或输入框重新选择`,
			);
		}
		const thinking =
			choice?.thinking ??
			(!choice || (choice.provider === configured.provider && choice.model === configured.model)
				? configured.thinking
				: undefined);
		const options = withThinking(model, profile.options ?? {}, thinking);
		validateProfileOptions(model.api, options, `profiles.${profileId}.options`);
		const auth = await this.#models.checkAuth(model.provider);
		if (auth === undefined) {
			throw new ModelGatewayError(
				"model_credentials_missing",
				`${model.provider} 没有可用凭据，请在设置中连接账号或输入 API key`,
			);
		}
		return this.#boundProfile(
			profileId,
			model,
			options,
			auth.source ?? `provider:${model.provider}`,
			auth.type,
			undefined,
			thinking,
		);
	}

	/** 普通恢复使用 turn 冻结的模型与参数，不被新配置隐式换绑。 */
	async bindFrozen(snapshot: ModelBindingSnapshot): Promise<BoundModelProfile> {
		const model = this.#models.getModel(snapshot.provider, snapshot.model);
		if (!model || model.api !== snapshot.api || model.baseUrl !== snapshot.baseUrl)
			throw new ModelGatewayError("model_not_found", `冻结模型不可用：${snapshot.provider}/${snapshot.model}`);
		validateProfileOptions(model.api, snapshot.options, "attempt.options");
		const auth = await this.#models.checkAuth(snapshot.provider);
		if (!auth) throw new ModelGatewayError("model_credentials_missing", `请重新连接 ${snapshot.provider}`);
		return this.#boundProfile(
			snapshot.modelProfileId,
			model,
			snapshot.options,
			snapshot.credentialSource,
			snapshot.credentialType,
			snapshot,
		);
	}

	#boundProfile(
		profileId: ModelProfileId,
		model: Model<Api>,
		options: ModelProfileOptions,
		credentialSource: string,
		credentialType: AuthType,
		frozen?: ModelBindingSnapshot,
		requestedThinking?: ModelChoice["thinking"],
	): BoundModelProfile {
		const thinking = requestedThinking ?? configuredThinking(model, options);
		const snapshot = freezeSnapshot(
			frozen ?? {
				modelProfileId: profileId,
				routingVersion: this.routingVersion,
				provider: model.provider,
				model: model.id,
				api: model.api,
				baseUrl: model.baseUrl,
				credentialSource,
				credentialType,
				options,
				...(thinking === undefined ? {} : { thinking }),
			},
		);
		return Object.freeze({
			snapshot,
			model,
			telemetryContext: this.#telemetryContext,
			stream: (context: Context, runtime?: ModelCallRuntimeOptions) =>
				tracedStream(runtime?.telemetryContext ?? this.#telemetryContext, snapshot, (span) =>
					this.#models.stream(model, context, callOptions(options, { ...runtime, telemetryContext: span }, span)),
				),
		});
	}
}

export interface CreateBuiltinModelGatewayOptions {
	credentials?: CredentialStore;
	authContext?: AuthContext;
	telemetryContext?: TelemetryContext;
}

export function createBuiltinModelGateway(
	config: ModelRoutingConfig,
	options: CreateBuiltinModelGatewayOptions = {},
): ModelGateway {
	const { telemetryContext, ...modelOptions } = options;
	return new ModelGateway(builtinModels(modelOptions), config, {
		...(telemetryContext === undefined ? {} : { telemetryContext }),
	});
}
