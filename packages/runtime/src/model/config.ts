export const MODEL_PROFILE_IDS = ["main", "writer", "reviewer", "source-reader", "source-extractor", "judge"] as const;

export type ModelProfileId = (typeof MODEL_PROFILE_IDS)[number];
/**
 * 面向作者的 profile 名称与用途：设置页（经 models.show）、预检与绑定的报错共用这一张表。
 * 2026-10-02 之前设置页另有一张，同一个 profile 在设置里叫「正文写作」、报错里叫「Writer」。
 */
export const MODEL_PROFILE_LABELS: Readonly<Record<ModelProfileId, { label: string; description: string }>> =
	Object.freeze({
		main: { label: "默认对话模型", description: "用于新对话；单次对话可在输入框另选模型。" },
		writer: { label: "正文写作", description: "生成和修订正文" },
		reviewer: { label: "独立审稿", description: "检查故事与正文质量" },
		"source-reader": { label: "原作阅读", description: "逐段读原作、写笔记" },
		"source-extractor": { label: "原作抽取", description: "从原作抽取情节与世界设定" },
		judge: { label: "评委", description: "盲读评测；应与正文写作用不同的模型" },
	});
export type RequiredModelProfileId = "main" | "reviewer";

export type ModelOptionValue =
	| string
	| number
	| boolean
	| null
	| readonly ModelOptionValue[]
	| { readonly [key: string]: ModelOptionValue };

export type ModelProfileOptions = Readonly<Record<string, ModelOptionValue>>;

export interface ModelProfileConfig {
	thinking?: NonNullable<import("@suiming/sdk").ModelChoice["thinking"]>;
	provider: string;
	model: string;
	options?: ModelProfileOptions;
}

export interface ModelRoutingConfig {
	/** 禁止新绑定；已有的对话与子任务按它们自己的绑定照旧使用。 */
	disabledProviders?: readonly string[];
	profiles: Readonly<
		Record<RequiredModelProfileId, ModelProfileConfig> & Partial<Record<ModelProfileId, ModelProfileConfig>>
	>;
}

export type ModelEnvironment = Readonly<Record<string, string | undefined>>;
