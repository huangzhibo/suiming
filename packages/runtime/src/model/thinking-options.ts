import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import { canonicalJson } from "@suiming/story";
import type { ModelProfileOptions } from "./config.js";
import { ModelGatewayError } from "./errors.js";

const KEYS = [
	"reasoningEffort",
	"thinkingEnabled",
	"thinkingBudgetTokens",
	"thinkingBudgets",
	"effort",
	"thinking",
	"reasoning",
	"promptMode",
];
const APIS = new Set([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"bedrock-converse-stream",
	"pi-messages",
]);
/** 只公布已接通参数映射的档位；自定义 API 继续通过高级参数配置。 */
export function thinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
	return APIS.has(model.api) && model.reasoning ? getSupportedThinkingLevels(model) : [];
}
/** 保留普通参数，统一清除旧思考参数，避免切换档位后两套参数互相覆盖。 */
export function withThinking(model: Model<Api>, options: ModelProfileOptions, level?: string): ModelProfileOptions {
	if (level === undefined) return options;
	if (level !== "default" && !thinkingLevels(model).includes(level as ModelThinkingLevel))
		throw new ModelGatewayError("invalid_model_options", `${model.name} 不支持思考深度 ${level}`);
	const clean = Object.fromEntries(Object.entries(options).filter(([key]) => !KEYS.includes(key)));
	if (level === "default") return clean;
	const enabled = level !== "off";
	const effort = level as Exclude<ModelThinkingLevel, "off">;
	switch (model.api) {
		case "openai-completions":
		case "openai-responses":
		case "azure-openai-responses":
			return { ...clean, ...(enabled ? { reasoningEffort: effort } : {}) };
		case "openai-codex-responses":
			return { ...clean, reasoningEffort: enabled ? effort : "none" };
		case "anthropic-messages": {
			if (!enabled) return { ...clean, thinkingEnabled: false };
			if ((model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking) {
				const mapped = model.thinkingLevelMap?.[effort];
				return {
					...clean,
					thinkingEnabled: true,
					effort: typeof mapped === "string" ? mapped : effort === "minimal" ? "low" : effort,
				};
			}
			const maxTokens =
				typeof clean.maxTokens === "number" ? Math.min(clean.maxTokens, model.maxTokens) : model.maxTokens;
			const thinkingBudgetTokens = clampThinkingBudgetToAnswerRoom(thinkingBudgetForLevel(effort), maxTokens);
			if (thinkingBudgetTokens < 1024)
				throw new ModelGatewayError("invalid_model_options", "当前输出上限不足以开启思考，请调高 maxTokens");
			return { ...clean, thinkingEnabled: true, thinkingBudgetTokens, maxTokens };
		}
		case "google-generative-ai":
		case "google-vertex": {
			if (!enabled) return { ...clean, thinking: { enabled: false } };
			const mapped = model.thinkingLevelMap?.[effort];
			const normalized = typeof mapped === "string" ? mapped.toLowerCase() : effort;
			if (!["minimal", "low", "medium", "high"].includes(normalized))
				throw new ModelGatewayError("invalid_model_options", "该模型的思考档位映射不可用");
			if (/gemini-3|gemma-?4|gemini-flash(?:-lite)?-latest/iu.test(model.id)) {
				const low = normalized === "minimal" || normalized === "low";
				const value = /gemini-3(?:\.\d+)?-pro/iu.test(model.id)
					? low
						? "LOW"
						: "HIGH"
					: /gemma-?4/iu.test(model.id)
						? low
							? "MINIMAL"
							: "HIGH"
						: normalized.toUpperCase();
				return { ...clean, thinking: { enabled: true, level: value } };
			}
			const budgets: Record<string, number> = {
				minimal: model.id.includes("flash-lite") ? 512 : 128,
				low: 2048,
				medium: 8192,
				high: model.id.includes("2.5-pro") ? 32768 : 24576,
			};
			return { ...clean, thinking: { enabled: true, budgetTokens: budgets[normalized] ?? 8192 } };
		}
		default:
			return { ...clean, ...(enabled ? { reasoning: effort } : {}) };
	}
}
/** 旧配置照常读取；无法对应标准档位时不猜测，界面显示“自定义”。 */
export function configuredThinking(
	model: Model<Api>,
	options: ModelProfileOptions = {},
): ModelThinkingLevel | undefined {
	const levels = thinkingLevels(model);
	for (const key of ["reasoningEffort", "reasoning"])
		if (levels.includes(options[key] as ModelThinkingLevel)) return options[key] as ModelThinkingLevel;
	if (options.thinkingEnabled === false || (options.thinking as { enabled?: boolean } | undefined)?.enabled === false)
		return levels.includes("off") ? "off" : undefined;
	const configured = Object.fromEntries(Object.entries(options).filter(([key]) => KEYS.includes(key)));
	for (const level of levels) {
		const candidate = Object.fromEntries(
			Object.entries(withThinking(model, {}, level)).filter(([key]) => KEYS.includes(key)),
		);
		if (canonicalJson(configured) === canonicalJson(candidate)) return level;
	}
	return undefined;
}
