import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelProfileOptions } from "./config.js";
import { ModelGatewayError } from "./errors.js";

/**
 * profile options 按 pi-ai 各 wire API 的选项类型校验（`ApiOptionsMap`）。Suiming 把 options 原样透传给
 * `Models.stream`，键名跟 API 走：写错键名以前会被静默忽略（R0 复现：`reasoning` 让 DeepSeek 请求变成
 * `thinking: disabled`），现在在 bind 时报 `invalid_model_options`。
 *
 * 这里只列 profile 可配置的键：凭据、header、fetch、signal、回调等请求生命周期项由 Gateway 拥有，
 * toolChoice 由 Harness 的工具面决定，都不允许出现在 profile 里。pi-ai 升级新增选项时同步这张表。
 */

const thinkingLevel = Type.Union([
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

const thinkingBudgets = Type.Record(Type.String(), Type.Integer({ minimum: 0 }));

/** pi-ai `StreamOptions` 里 profile 可以配置的部分。 */
const common = {
	temperature: Type.Number({ minimum: 0 }),
	maxTokens: Type.Integer({ minimum: 1 }),
	samplingParams: Type.Record(Type.String(), Type.Unknown()),
	cacheRetention: Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]),
	metadata: Type.Record(Type.String(), Type.Unknown()),
	transport: Type.Union([
		Type.Literal("sse"),
		Type.Literal("websocket"),
		Type.Literal("websocket-cached"),
		Type.Literal("auto"),
	]),
	timeoutMs: Type.Integer({ minimum: 0 }),
	maxRetries: Type.Integer({ minimum: 0 }),
	maxRetryDelayMs: Type.Integer({ minimum: 0 }),
	websocketConnectTimeoutMs: Type.Integer({ minimum: 0 }),
};

const reasoningSummary = Type.Union([
	Type.Literal("auto"),
	Type.Literal("detailed"),
	Type.Literal("concise"),
	Type.Null(),
]);

const googleThinking = Type.Object(
	{
		enabled: Type.Boolean(),
		budgetTokens: Type.Optional(Type.Integer({ minimum: 0 })),
		level: Type.Optional(
			Type.Union([
				Type.Literal("THINKING_LEVEL_UNSPECIFIED"),
				Type.Literal("MINIMAL"),
				Type.Literal("LOW"),
				Type.Literal("MEDIUM"),
				Type.Literal("HIGH"),
			]),
		),
	},
	{ additionalProperties: false },
);

const thinkingDisplay = Type.Union([Type.Literal("summarized"), Type.Literal("omitted")]);

function api(fields: Record<string, TSchema>): TSchema {
	// 不用 Type.Partial：它会丢掉 additionalProperties: false，未知键就又被放行了。
	const optional = Object.fromEntries(
		Object.entries({ ...common, ...fields }).map(([key, schema]) => [key, Type.Optional(schema)]),
	);
	return Type.Object(optional, { additionalProperties: false });
}

/** 键是 pi-ai 的 `Api` 字符串；不在表里的自定义 API 无法校验，只做通用键之外的放行。 */
const API_OPTION_SCHEMAS: Readonly<Record<string, TSchema>> = {
	"openai-completions": api({ reasoningEffort: thinkingLevel, thinkingBudgets }),
	"openai-responses": api({ reasoningEffort: thinkingLevel, reasoningSummary, serviceTier: Type.String() }),
	"openai-codex-responses": api({
		reasoningEffort: Type.Union([Type.Literal("none"), thinkingLevel]),
		reasoningSummary: Type.Union([reasoningSummary, Type.Literal("off"), Type.Literal("on")]),
		serviceTier: Type.String(),
		textVerbosity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
	}),
	"azure-openai-responses": api({
		reasoningEffort: thinkingLevel,
		reasoningSummary,
		azureApiVersion: Type.String(),
		azureResourceName: Type.String(),
		azureBaseUrl: Type.String(),
		azureDeploymentName: Type.String(),
	}),
	"anthropic-messages": api({
		thinkingEnabled: Type.Boolean(),
		thinkingBudgetTokens: Type.Integer({ minimum: 0 }),
		effort: Type.Union([
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
		thinkingDisplay,
		interleavedThinking: Type.Boolean(),
	}),
	"google-generative-ai": api({ thinking: googleThinking }),
	"google-vertex": api({ thinking: googleThinking, project: Type.String(), location: Type.String() }),
	"mistral-conversations": api({ promptMode: Type.Literal("reasoning"), reasoningEffort: Type.String() }),
	"bedrock-converse-stream": api({
		region: Type.String(),
		profile: Type.String(),
		reasoning: thinkingLevel,
		thinkingBudgets,
		interleavedThinking: Type.Boolean(),
		thinkingDisplay,
		requestMetadata: Type.Record(Type.String(), Type.String()),
	}),
	"pi-messages": api({ reasoning: thinkingLevel, debug: Type.Boolean() }),
};

function allowedKeys(schema: TSchema): string[] {
	const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
	return Object.keys(properties).sort();
}

/** 已知 API 的 profile options 键；未知 API 返回 undefined。 */
export function profileOptionKeysForApi(apiId: string): string[] | undefined {
	const schema = API_OPTION_SCHEMAS[apiId];
	return schema === undefined ? undefined : allowedKeys(schema);
}

/**
 * 在 bind 时校验：模型的 API 已知就按它的选项 schema 逐键检查，未知 API 只能放行。
 * 报错带上该 API 允许的键，让写错的人一眼看到该用哪个名字。
 */
export function validateProfileOptions(apiId: string, options: ModelProfileOptions, label: string): void {
	const schema = API_OPTION_SCHEMAS[apiId];
	if (schema === undefined) return;
	if (Value.Check(schema, options)) return;
	const first = [...Value.Errors(schema, options)][0];
	let detail = "does not match the option schema";
	if (first !== undefined) {
		const unknown = (first.params as { additionalProperties?: string[] }).additionalProperties;
		const at = first.instancePath.replace(/^\//u, "").replaceAll("/", ".");
		detail =
			first.keyword === "additionalProperties" && unknown !== undefined
				? `unknown keys: ${unknown.join(", ")}`
				: at.length === 0
					? first.message
					: `${at}: ${first.message}`;
	}
	throw new ModelGatewayError(
		"invalid_model_options",
		`${label} is invalid for api ${apiId} (${detail}); allowed keys: ${allowedKeys(schema).join(", ")}`,
	);
}
