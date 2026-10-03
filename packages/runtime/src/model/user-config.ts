import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelThinkingSchema } from "@suiming/sdk";
import { parse as parseToml, TomlDate, TomlError } from "smol-toml";
import { Value } from "typebox/value";
import type {
	ModelEnvironment,
	ModelOptionValue,
	ModelProfileConfig,
	ModelProfileId,
	ModelProfileOptions,
	ModelRoutingConfig,
} from "./config.js";
import { MODEL_PROFILE_IDS } from "./config.js";
import { ModelGatewayError } from "./errors.js";

const CONFIG_PATH_ENV = "SUIMING_CONFIG_PATH";

const ENVIRONMENT_NAMES: Record<ModelProfileId, { provider: string; model: string; options: string }> = {
	main: {
		provider: "SUIMING_MAIN_MODEL_PROVIDER",
		model: "SUIMING_MAIN_MODEL_ID",
		options: "SUIMING_MAIN_MODEL_OPTIONS",
	},
	reviewer: {
		provider: "SUIMING_REVIEWER_MODEL_PROVIDER",
		model: "SUIMING_REVIEWER_MODEL_ID",
		options: "SUIMING_REVIEWER_MODEL_OPTIONS",
	},
	writer: {
		provider: "SUIMING_WRITER_MODEL_PROVIDER",
		model: "SUIMING_WRITER_MODEL_ID",
		options: "SUIMING_WRITER_MODEL_OPTIONS",
	},
	"source-reader": {
		provider: "SUIMING_SOURCE_READER_MODEL_PROVIDER",
		model: "SUIMING_SOURCE_READER_MODEL_ID",
		options: "SUIMING_SOURCE_READER_MODEL_OPTIONS",
	},
	"source-extractor": {
		provider: "SUIMING_SOURCE_EXTRACTOR_MODEL_PROVIDER",
		model: "SUIMING_SOURCE_EXTRACTOR_MODEL_ID",
		options: "SUIMING_SOURCE_EXTRACTOR_MODEL_OPTIONS",
	},
	judge: {
		provider: "SUIMING_JUDGE_MODEL_PROVIDER",
		model: "SUIMING_JUDGE_MODEL_ID",
		options: "SUIMING_JUDGE_MODEL_OPTIONS",
	},
};

type ParsedProfile = Partial<ModelProfileConfig>;

interface ParsedUserConfig {
	version: number;
	profiles: Partial<Record<ModelProfileId, ParsedProfile>>;
	disabledProviders?: string[];
	cloud?: { endpoint?: string; actorId?: string };
}

export interface CloudConnectionConfig {
	endpoint?: string;
	actorId?: string;
}

export interface LoadCloudConnectionConfigOptions {
	configPath?: string;
	environment?: ModelEnvironment;
}

export interface LoadedCloudConnectionConfig {
	config: CloudConnectionConfig;
	diagnostic: { configPath: string; configFile: "loaded" | "missing" };
}

export type ModelConfigValueSource = "environment" | "user-config" | "main-default" | "default-empty";

export interface ModelProfileConfigDiagnostic {
	provider: string;
	model: string;
	providerSource: ModelConfigValueSource;
	modelSource: ModelConfigValueSource;
	optionsSource: ModelConfigValueSource;
	optionKeys: string[];
}

export interface ModelRoutingConfigDiagnostic {
	configPath: string;
	configFile: "loaded" | "missing";
	profiles: Readonly<Record<ModelProfileId, ModelProfileConfigDiagnostic>>;
}

export interface LoadedModelRoutingConfig {
	config: ModelRoutingConfig;
	diagnostic: ModelRoutingConfigDiagnostic;
}

export interface LoadModelRoutingConfigOptions {
	configPath?: string;
	environment?: ModelEnvironment;
}

function configError(message: string): ModelGatewayError {
	return new ModelGatewayError("invalid_model_config_file", message);
}

function isTable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof TomlDate);
}

function requireTable(value: unknown, label: string): Record<string, unknown> {
	if (!isTable(value)) throw configError(`${label} must be a TOML table`);
	return value;
}

function rejectUnknownKeys(table: Record<string, unknown>, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(table)) {
		if (!allowed.includes(key)) throw configError(`${label} has unsupported key ${key}`);
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw configError(`${label} must be a string`);
	return value;
}

/** options 值只接受 JSON 能表达的 TOML 值；日期没有对应的模型选项语义。 */
function optionValue(value: unknown, label: string): ModelOptionValue {
	if (value instanceof TomlDate) throw configError(`${label} must not be a date`);
	if (typeof value === "bigint") throw configError(`${label} is out of the safe integer range`);
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw configError(`${label} must be a finite number`);
		return value;
	}
	if (Array.isArray(value)) return value.map((item, index) => optionValue(item, `${label}[${index}]`));
	if (isTable(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, optionValue(item, `${label}.${key}`)]),
		);
	}
	throw configError(`${label} has an unsupported value`);
}

/**
 * ~/.suiming/config.toml：TOML 语法交给 smol-toml，这里只校验 Suiming 认识的形状。
 * 根只有 version、models、cloud；profile 只有 provider、model、thinking、options；未知表和键直接报错，不静默忽略。
 */
export function parseModelRoutingToml(source: string): ParsedUserConfig {
	let raw: unknown;
	try {
		raw = parseToml(source);
	} catch (error) {
		throw configError(
			`config.toml is not valid TOML: ${error instanceof TomlError ? error.message.split("\n", 1)[0] : String(error)}`,
		);
	}
	const root = requireTable(raw, "config.toml");
	rejectUnknownKeys(root, ["version", "models", "cloud"], "config.toml");
	const version = root.version;
	if (typeof version !== "number" || !Number.isInteger(version)) {
		throw configError("config.toml must declare an integer version");
	}
	if (version !== 1) throw configError(`config.toml version must be 1, received ${version}`);

	let cloud: ParsedUserConfig["cloud"];
	if (root.cloud !== undefined) {
		const table = requireTable(root.cloud, "cloud");
		rejectUnknownKeys(table, ["endpoint", "actor_id"], "cloud");
		cloud = {
			...(table.endpoint === undefined ? {} : { endpoint: requireString(table.endpoint, "cloud.endpoint") }),
			...(table.actor_id === undefined ? {} : { actorId: requireString(table.actor_id, "cloud.actor_id") }),
		};
	}

	let disabledProviders: string[] | undefined;
	const profiles: ParsedUserConfig["profiles"] = {};
	if (root.models !== undefined) {
		const models = requireTable(root.models, "models");
		rejectUnknownKeys(models, ["profiles", "disabled_providers"], "models");
		if (models.disabled_providers !== undefined) {
			if (
				!Array.isArray(models.disabled_providers) ||
				models.disabled_providers.some((id) => typeof id !== "string" || !id.trim())
			)
				throw configError("models.disabled_providers must be an array of provider ids");
			disabledProviders = [...new Set((models.disabled_providers as string[]).map((id) => id.trim()))];
		}
		if (models.profiles !== undefined) {
			const table = requireTable(models.profiles, "models.profiles");
			rejectUnknownKeys(table, MODEL_PROFILE_IDS, "models.profiles");
			for (const profileId of MODEL_PROFILE_IDS) {
				const entry = table[profileId];
				if (entry === undefined) continue;
				const label = `models.profiles.${profileId}`;
				const profile = requireTable(entry, label);
				rejectUnknownKeys(profile, ["provider", "model", "thinking", "options"], label);
				const parsed: ParsedProfile = {};
				if (profile.thinking !== undefined) {
					if (!Value.Check(modelThinkingSchema, profile.thinking))
						throw configError(`${label}.thinking is invalid`);
					parsed.thinking = profile.thinking;
				}
				if (profile.provider !== undefined) parsed.provider = requireString(profile.provider, `${label}.provider`);
				if (profile.model !== undefined) parsed.model = requireString(profile.model, `${label}.model`);
				if (profile.options !== undefined) {
					const options = requireTable(profile.options, `${label}.options`);
					parsed.options = Object.fromEntries(
						Object.entries(options).map(([key, value]) => [key, optionValue(value, `${label}.options.${key}`)]),
					);
				}
				profiles[profileId] = parsed;
			}
		}
	}
	return {
		version,
		profiles,
		...(disabledProviders === undefined ? {} : { disabledProviders }),
		...(cloud === undefined ? {} : { cloud }),
	};
}

function optionalEnvironmentValue(environment: ModelEnvironment, name: string): string | undefined {
	const value = environment[name]?.trim();
	return value === undefined || value.length === 0 ? undefined : value;
}

function environmentOptions(environment: ModelEnvironment, name: string): ModelProfileOptions | undefined {
	const source = optionalEnvironmentValue(environment, name);
	if (source === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch (error) {
		throw new ModelGatewayError(
			"invalid_model_options",
			`${name} must be a JSON object: ${(error as Error).message}`,
		);
	}
	if (value === null || Array.isArray(value) || typeof value !== "object") {
		throw new ModelGatewayError("invalid_model_options", `${name} must be a JSON object`);
	}
	return value as ModelProfileOptions;
}

function valueWithSource<T>(
	environment: T | undefined,
	userConfig: T | undefined,
): { value?: T; source?: ModelConfigValueSource } {
	if (environment !== undefined) return { value: environment, source: "environment" };
	if (userConfig !== undefined) return { value: userConfig, source: "user-config" };
	return {};
}

function requireResolved(
	profileId: ModelProfileId,
	field: "provider" | "model",
	resolved: { value?: string; source?: ModelConfigValueSource },
): { value: string; source: ModelConfigValueSource } {
	if (resolved.value === undefined || resolved.source === undefined) {
		throw new ModelGatewayError("missing_model_config", `models.profiles.${profileId}.${field} must be configured`);
	}
	if (resolved.value.trim().length === 0) {
		throw new ModelGatewayError("invalid_model_config", `models.profiles.${profileId}.${field} must not be empty`);
	}
	return { value: resolved.value.trim(), source: resolved.source };
}

export async function loadModelRoutingConfig(
	options: LoadModelRoutingConfigOptions = {},
): Promise<LoadedModelRoutingConfig> {
	const environment = options.environment ?? process.env;
	const environmentPath = optionalEnvironmentValue(environment, CONFIG_PATH_ENV);
	const configPath = options.configPath ?? environmentPath ?? join(homedir(), ".suiming", "config.toml");
	let parsed: ParsedUserConfig = { version: 1, profiles: {} };
	let configFile: ModelRoutingConfigDiagnostic["configFile"] = "missing";
	try {
		parsed = parseModelRoutingToml(await readFile(configPath, "utf8"));
		configFile = "loaded";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (options.configPath !== undefined || environmentPath !== undefined) {
			throw new ModelGatewayError("model_config_not_found", `Model config file does not exist: ${configPath}`);
		}
	}

	const resolvedProfiles = {} as Record<ModelProfileId, ModelProfileConfig>;
	const diagnostics = {} as Record<ModelProfileId, ModelProfileConfigDiagnostic>;
	for (const profileId of MODEL_PROFILE_IDS) {
		const names = ENVIRONMENT_NAMES[profileId];
		const user = parsed.profiles[profileId];
		const provider = valueWithSource(optionalEnvironmentValue(environment, names.provider), user?.provider);
		const model = valueWithSource(optionalEnvironmentValue(environment, names.model), user?.model);
		const modelOptions = valueWithSource(environmentOptions(environment, names.options), user?.options);

		const external = [provider.source, model.source, modelOptions.source].includes("environment");
		const thinking = external ? undefined : user?.thinking;

		if (profileId !== "main" && provider.value === undefined && model.value === undefined) {
			const fallback = resolvedProfiles.main;
			resolvedProfiles[profileId] = {
				provider: fallback.provider,
				model: fallback.model,
				...(thinking !== undefined
					? { thinking }
					: modelOptions.value === undefined && fallback.thinking !== undefined
						? { thinking: fallback.thinking }
						: {}),
				...(modelOptions.value === undefined
					? fallback.options === undefined
						? {}
						: { options: fallback.options }
					: { options: modelOptions.value }),
			};
			diagnostics[profileId] = {
				provider: fallback.provider,
				model: fallback.model,
				providerSource: "main-default",
				modelSource: "main-default",
				optionsSource: modelOptions.source ?? "main-default",
				optionKeys: Object.keys(modelOptions.value ?? fallback.options ?? {}).sort(),
			};
			continue;
		}

		const requiredProvider = requireResolved(profileId, "provider", provider);
		const requiredModel = requireResolved(profileId, "model", model);
		resolvedProfiles[profileId] = {
			provider: requiredProvider.value,
			model: requiredModel.value,
			...(thinking === undefined ? {} : { thinking }),
			...(modelOptions.value === undefined ? {} : { options: modelOptions.value }),
		};
		diagnostics[profileId] = {
			provider: requiredProvider.value,
			model: requiredModel.value,
			providerSource: requiredProvider.source,
			modelSource: requiredModel.source,
			optionsSource: modelOptions.source ?? "default-empty",
			optionKeys: Object.keys(modelOptions.value ?? {}).sort(),
		};
	}

	return {
		config: {
			profiles: resolvedProfiles,
			...(parsed.disabledProviders === undefined ? {} : { disabledProviders: parsed.disabledProviders }),
		},
		diagnostic: { configPath, configFile, profiles: diagnostics },
	};
}

export async function loadCloudConnectionConfig(
	options: LoadCloudConnectionConfigOptions = {},
): Promise<LoadedCloudConnectionConfig> {
	const environment = options.environment ?? process.env;
	const environmentPath = optionalEnvironmentValue(environment, CONFIG_PATH_ENV);
	const configPath = options.configPath ?? environmentPath ?? join(homedir(), ".suiming", "config.toml");
	let parsed: ParsedUserConfig = { version: 1, profiles: {} };
	let configFile: LoadedCloudConnectionConfig["diagnostic"]["configFile"] = "missing";
	try {
		parsed = parseModelRoutingToml(await readFile(configPath, "utf8"));
		configFile = "loaded";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (options.configPath !== undefined || environmentPath !== undefined) {
			throw new ModelGatewayError("cloud_config_not_found", `Suiming config file does not exist: ${configPath}`);
		}
	}
	const endpoint = optionalEnvironmentValue(environment, "SUIMING_CLOUD_ENDPOINT") ?? parsed.cloud?.endpoint;
	const actorId = optionalEnvironmentValue(environment, "SUIMING_CLOUD_ACTOR_ID") ?? parsed.cloud?.actorId;
	return {
		config: {
			...(endpoint === undefined ? {} : { endpoint }),
			...(actorId === undefined ? {} : { actorId }),
		},
		diagnostic: { configPath, configFile },
	};
}
