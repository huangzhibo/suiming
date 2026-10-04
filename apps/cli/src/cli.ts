import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	ArtifactError,
	abandonPausedSession,
	type CheckDiagnostic,
	type CloudProjectStore,
	checkDiagnostic,
	checkStoryText,
	checkSummary,
	commitResult,
	committedReviews,
	compileHostContext,
	composeHostReview,
	createBuiltinModelGateway,
	type InspectedSource,
	inspectRelease,
	inspectStorySourcesCandidate,
	JsonFileCredentialStore,
	LocalCloudSyncService,
	type LocalProjectDiff,
	LocalProjectService,
	LocalSessionController,
	loadModelRoutingConfig,
	loadUsageCheckpoint,
	type ModelGateway,
	notActiveInProcess,
	parseStoryImpactSubject,
	productEventSnapshot,
	publishRelease,
	RANK_RUBRICS,
	type RankRubric,
	type RankRunResult,
	ReviewDraftSchema,
	readProjectStatus,
	reviewSummary,
	revisionSummary,
	rollbackResult,
	runRankExperiment,
	type SessionEvent,
	type SourceCoverage,
	SuimingHarness,
	type SuimingTelemetry,
	sessionSummaries,
	sessionSummary,
	sourceCoverage,
	storyImpact,
	taskSummaries,
	telemetryFromEnvironment,
} from "@suiming/runtime";
import {
	errorCategory,
	retryableErrorCode,
	SUIM_CLI_COMMAND_DATA,
	SUIM_CLI_PROTOCOL_VERSION,
	type SuimCliCommand,
	type SuimCliError,
	type SuimCliEvent,
	type SuimCliSuccess,
	type SuimErrorCategory,
} from "@suiming/sdk";
import {
	canonicalJson,
	type Diagnostic,
	parseReleaseManifest,
	parseYaml,
	renderTargetStoryLanguageSchemaGuide,
} from "@suiming/story";
import { Command, CommanderError, Help } from "commander";
import { Value } from "typebox/value";
import { installedHosts, installHost, parseHostId, readIntentFile } from "./host-install.js";

/** 渲染成两列宽的字符：CJK、全角标点与中日韩假名。 */
const WIDE_CHARACTER =
	/[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;

/**
 * commander 按 UTF-16 长度算列宽（`displayWidth` 默认就是 `.length`），一个汉字算 1 却占 2 列，
 * 于是中文帮助的描述列对不齐、折行也提前。按实际渲染宽度重算。
 */
function displayColumns(text: string): number {
	let width = 0;
	for (const character of stripVTControlCharacters(text)) width += WIDE_CHARACTER.test(character) ? 2 : 1;
	return width;
}

/** commander 自己拼进用法行与子命令行的固定英文；它没给这两个片段单独的钩子，只能事后替。 */
function localizeHelpFragments(text: string): string {
	return text.replace("[options]", "[选项]").replace("[command]", "[命令]");
}

/** commander 内置分节标题的中文；未列出的原样输出。 */
const HELP_TITLES: Record<string, string> = {
	"Usage:": "用法：",
	"Arguments:": "参数：",
	"Options:": "选项：",
	"Global Options:": "全局选项：",
	"Commands:": "命令：",
};

export const SUIM_CLI_EXIT = {
	success: 0,
	internal: 1,
	usage: 2,
	validation: 3,
	conflict: 4,
	configuration: 5,
	notFound: 6,
	interrupted: 7,
} as const;

/** 与 apps/cli/package.json 同源；`suim --version` 打印它并以 0 退出。 */
export const SUIM_CLI_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
	.version;

export interface SuimCliIo {
	cwd(): string;
	stdout(text: string): void;
	stderr(text: string): void;
	/** 注册一次取消回调（进程里是 SIGINT / SIGTERM），返回注销函数；缺省表示不支持取消。 */
	onInterrupt?(handler: () => void): () => void;
	resolveModelGateway?(options: { configPath?: string; authPath?: string }): Promise<ModelGateway>;
	/** 观测后端；缺省按 LANGFUSE_* 环境变量决定，没有就 NOOP。测试注入自己的。 */
	telemetry?: SuimingTelemetry;
	cloudDefaults?(options: {
		configPath?: string;
	}): { endpoint?: string; actorId?: string } | Promise<{ endpoint?: string; actorId?: string }>;
	resolveCloudProjectStore?(options: { endpoint: string; actorId: string }): Promise<CloudProjectStore>;
}

interface GlobalOptions {
	json?: boolean;
	project?: string;
}

interface CloudConnectionOptions {
	endpoint?: string;
	actor?: string;
	config?: string;
}

interface CommandFailure {
	code: string;
	message: string;
	retryable: boolean;
	exitCode: number;
	diagnostics?: CheckDiagnostic[];
}

/** exit code 从错误类别派生（ADR-0009 决定 17）；类别由 @suiming/sdk 的命名约定给出，CLI 不再维护错误码清单。 */
const EXIT_BY_CATEGORY: Readonly<Record<SuimErrorCategory, number>> = {
	usage: SUIM_CLI_EXIT.usage,
	validation: SUIM_CLI_EXIT.validation,
	conflict: SUIM_CLI_EXIT.conflict,
	configuration: SUIM_CLI_EXIT.configuration,
	not_found: SUIM_CLI_EXIT.notFound,
	interrupted: SUIM_CLI_EXIT.interrupted,
	internal: SUIM_CLI_EXIT.internal,
};

/**
 * commander 的错误信息是内置英文，两处用到同一个字符串：写 stderr 的那份走 `configureOutput.outputError`，
 * 进 JSON 信封的那份是 `CommanderError.message`。所以在这里翻一次，两处都用。
 * 没命中的模板原样返回——commander 升级换了说法时宁可露出英文，也不猜着改。
 */
const COMMANDER_MESSAGES: [RegExp, string][] = [
	[/^error: unknown command '(.*)'$/u, "错误：未知命令 '$1'"],
	[/^error: unknown option '(.*)'$/u, "错误：未知选项 '$1'"],
	[/^error: missing required argument '(.*)'$/u, "错误：缺少必填参数 '$1'"],
	[/^error: option '(.*)' argument missing$/u, "错误：选项 '$1' 缺少取值"],
	[/^error: required option '(.*)' not specified$/u, "错误：必须指定选项 '$1'"],
	[
		/^error: option '(.*)' value '(.*)' from env '(.*)' is invalid\. ?(.*)$/u,
		"错误：选项 '$1' 从环境变量 '$3' 读到的值 '$2' 无效。$4",
	],
	[/^error: option '(.*)' argument '(.*)' is invalid\. ?(.*)$/u, "错误：选项 '$1' 的取值 '$2' 无效。$3"],
	[
		/^error: command-argument value '(.*)' is invalid for argument '(.*)'\. ?(.*)$/u,
		"错误：参数 '$2' 的取值 '$1' 无效。$3",
	],
	[
		/^error: too many arguments for '(.*)' command\. Expected (\d+) arguments? but got (\d+): (.*)\.$/u,
		"错误：'$1' 的参数过多，期望 $2 个，实际 $3 个：$4。",
	],
	[
		/^error: too many arguments\. Expected (\d+) arguments? but got (\d+): (.*)\.$/u,
		"错误：参数过多，期望 $1 个，实际 $2 个：$3。",
	],
	[/^error: option '(.*)' cannot be used with option '(.*)'$/u, "错误：选项 '$1' 不能与选项 '$2' 同时使用"],
];

function localizeCommanderError(message: string): string {
	const trailingNewline = message.endsWith("\n") ? "\n" : "";
	const [first = "", ...rest] = message.trimEnd().split("\n");
	let head = first;
	for (const [pattern, replacement] of COMMANDER_MESSAGES) {
		const localized = head.replace(pattern, replacement);
		if (localized !== head) {
			head = localized;
			break;
		}
	}
	const suggestions = rest.map((line) =>
		line
			.replace(/^\(Did you mean one of (.*)\?\)$/u, "（是不是想用 $1 之一？）")
			.replace(/^\(Did you mean (.*)\?\)$/u, "（是不是想用 $1？）"),
	);
	return `${[head, ...suggestions].join("\n")}${trailingNewline}`;
}

function commanderDisplayedOutput(error: unknown): boolean {
	return (
		error instanceof CommanderError &&
		(error.code === "commander.helpDisplayed" || error.code === "commander.version")
	);
}

function failure(error: unknown): CommandFailure {
	if (error instanceof CommanderError) {
		return {
			code: "invalid_cli_usage",
			message: localizeCommanderError(error.message),
			retryable: false,
			exitCode: commanderDisplayedOutput(error) ? SUIM_CLI_EXIT.success : SUIM_CLI_EXIT.usage,
		};
	}
	const codedError =
		error instanceof ArtifactError ||
		(error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string")
			? (error as Error & { code: string })
			: undefined;
	if (codedError !== undefined) {
		const retryable = (codedError as { retryable?: unknown }).retryable;
		// SuimError（绑定期的 BookParseError 等）带着全部诊断；message 只是「共 N 处，第一处：…」的汇总
		const diagnostics = (codedError as { diagnostics?: unknown }).diagnostics;
		return {
			code: codedError.code,
			message: codedError.message,
			retryable: typeof retryable === "boolean" ? retryable : retryableErrorCode(codedError.code),
			exitCode: EXIT_BY_CATEGORY[errorCategory(codedError.code)],
			...(Array.isArray(diagnostics) && diagnostics.length > 0
				? { diagnostics: (diagnostics as Diagnostic[]).map(checkDiagnostic) }
				: {}),
		};
	}
	return {
		code: "internal_error",
		message: error instanceof Error ? error.message : "未知的 CLI 故障",
		retryable: false,
		exitCode: SUIM_CLI_EXIT.internal,
	};
}

function diffData(diff: LocalProjectDiff) {
	return {
		projectId: diff.projectId,
		baseRevisionId: diff.baseRevisionId,
		state: diff.state,
		entries: diff.entries.map((entry) => ({
			kind: entry.kind,
			identity: entry.identity,
			...(entry.before === undefined
				? {}
				: {
						before: {
							path: entry.before.path,
							mediaType: entry.before.mediaType,
							contentSha256: entry.before.contentSha256,
							byteLength: entry.before.bytes.byteLength,
						},
					}),
			...(entry.after === undefined
				? {}
				: {
						after: {
							path: entry.after.path,
							mediaType: entry.after.mediaType,
							contentSha256: entry.after.contentSha256,
							byteLength: entry.after.bytes.byteLength,
						},
					}),
		})),
		ignored: diff.ignored,
	};
}

function projectData(service: LocalProjectService) {
	const project = service.project();
	return {
		projectId: project.id,
		checkoutPath: project.checkoutPath,
		headRevisionId: project.headRevisionId,
	};
}

function sourceSummaryData(item: InspectedSource, coverage?: SourceCoverage) {
	return {
		sourceId: item.sourceId,
		state: item.state,
		name: item.descriptor.name,
		...(item.descriptor.encoding === undefined ? {} : { encoding: item.descriptor.encoding }),
		originalByteLength: item.originalByteLength,
		materialCodePoints: item.materialCodePoints,
		...(coverage === undefined
			? {}
			: {
					coverage: {
						materialSha256: coverage.materialSha256,
						covered: coverage.covered,
						gaps: coverage.gaps,
						notes: coverage.notes,
					},
				}),
		...(item.check === undefined
			? {}
			: {
					check: {
						passed: item.check.passed,
						openContractIds: item.check.contracts.openContractIds,
					},
				}),
	};
}

function sessionTitle(service: LocalProjectService, sessionId: string): string {
	return service.firstInboxText(sessionId);
}

function sessionShowData(service: LocalProjectService, sessionId: string) {
	const snapshot = service.loadExecutionEntities();
	const session = snapshot.sessions.find((item) => item.id === sessionId);
	if (session === undefined) throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
	return {
		session: sessionSummary(session, sessionTitle(service, sessionId)),
		tasks: taskSummaries(snapshot, sessionId),
	};
}

/** 一个 turn 跑完后的回话：session 状态、head 与 Agent 最后一条完整回复。 */
function sessionTurnData(service: LocalProjectService, sessionId: string) {
	const snapshot = service.loadExecutionEntities();
	const session = snapshot.sessions.find((item) => item.id === sessionId);
	if (session === undefined) throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
	const messages = productEventSnapshot(service.readSessionEvents(sessionId)).find(
		(event) => event.type === "MESSAGES_SNAPSHOT",
	);
	const reply =
		messages?.type === "MESSAGES_SNAPSHOT"
			? [...messages.messages]
					.reverse()
					.find(
						(message) =>
							message.role === "assistant" &&
							typeof message.content === "string" &&
							message.metadata?.suiming?.taskKind === "agent",
					)
			: undefined;
	return {
		projectId: service.projectId,
		session: sessionSummary(session, sessionTitle(service, sessionId)),
		headRevisionId: service.project().headRevisionId,
		reply: typeof reply?.content === "string" ? reply.content : "",
	};
}

function localRankData(service: LocalProjectService, result: RankRunResult) {
	return {
		projectId: service.projectId,
		sessionId: result.session.id,
		headRevisionId: service.project().headRevisionId,
		storyBeatId: result.storyBeatId,
		rounds: result.rounds,
		rubric: result.rubric,
		judge: result.judge,
		ranking: result.ranking,
		roundResultObjectIds: result.roundResultObjectIds,
	};
}

function suimingHarness(io: SuimCliIo, service: LocalProjectService, models: ModelGateway): SuimingHarness {
	return new SuimingHarness({
		project: service,
		models,
		telemetryContext: cliTelemetry(io).context,
	});
}

/**
 * host 或作者用 SIGINT / SIGTERM 中止一次 `suim session send`：当前 turn 收口回 idle，消息列表与候选保留，
 * 再发一条消息就继续。没有信号处理时进程会被直接杀掉，留下一个只能等进程 lease 判死才收敛的 session。
 */
async function withInterrupt<T>(io: SuimCliIo, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	const dispose = io.onInterrupt?.(() => {
		if (!controller.signal.aborted) controller.abort(new Error("Interrupted by signal"));
	});
	try {
		return await body(controller.signal);
	} finally {
		dispose?.();
	}
}

/** --events：每个 SessionEvent 一行 NDJSON，与最终响应同一 stdout；每行自带 protocolVersion 与 command。 */
function eventWriter(
	io: SuimCliIo,
	command: SuimCliCommand,
	enabled: boolean,
): ((event: SessionEvent) => void) | undefined {
	if (!enabled) return undefined;
	return (event) => {
		const line: SuimCliEvent = { protocolVersion: SUIM_CLI_PROTOCOL_VERSION, command, event };
		io.stdout(`${JSON.stringify(line)}\n`);
	};
}

/** 只有一种输出：带 protocolVersion 与 command 的 JSON envelope；没有面向人的第二种格式。 */
function outputSuccess(io: SuimCliIo, command: SuimCliCommand, data: SuimCliSuccess["data"]): void {
	// 命令目录是契约：不符合自己 schema 的响应是程序错误，宁可失败也不输出。
	if (!Value.Check(SUIM_CLI_COMMAND_DATA[command], data)) {
		const first = [...Value.Errors(SUIM_CLI_COMMAND_DATA[command], data)][0];
		throw new ArtifactError(
			"invalid_cli_response",
			`${command} 的响应不符合它自己的契约：${first?.instancePath ?? ""} ${first?.message ?? ""}`.trim(),
		);
	}
	const response: SuimCliSuccess = { protocolVersion: SUIM_CLI_PROTOCOL_VERSION, command, ok: true, data };
	io.stdout(`${JSON.stringify(response)}\n`);
}

function outputFailure(io: SuimCliIo, command: SuimCliError["command"], value: CommandFailure): void {
	const response: SuimCliError = {
		protocolVersion: SUIM_CLI_PROTOCOL_VERSION,
		command,
		ok: false,
		error: {
			code: value.code,
			message: value.message,
			retryable: value.retryable,
			...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics }),
		},
	};
	io.stdout(`${JSON.stringify(response)}\n`);
}

function projectPath(program: Command, explicit?: string): string {
	const options = program.opts<GlobalOptions>();
	return resolve(explicit ?? options.project ?? process.cwd());
}

async function readSourceInput(path: string): Promise<Uint8Array> {
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new ArtifactError("source_input_not_found", `Source 输入不存在：${path}`);
		}
		throw error;
	}
}

/**
 * 一次 CLI 调用只有一个 telemetry 实例：Gateway、SuimingHarness 与退出前的 flush 必须共用同一个 provider，
 * 否则退出时 flush 的是另一个实例，最后一批 span（session / turn 根、Task、末次调用）会丢。
 */
const telemetryByIo = new WeakMap<SuimCliIo, SuimingTelemetry>();

function cliTelemetry(io: SuimCliIo): SuimingTelemetry {
	const existing = telemetryByIo.get(io);
	if (existing !== undefined) return existing;
	const created = io.telemetry ?? telemetryFromEnvironment(process.env);
	telemetryByIo.set(io, created);
	return created;
}

async function modelGateway(io: SuimCliIo, options: { config?: string; auth?: string }): Promise<ModelGateway> {
	if (io.resolveModelGateway !== undefined) {
		return io.resolveModelGateway({
			...(options.config === undefined ? {} : { configPath: resolve(options.config) }),
			...(options.auth === undefined ? {} : { authPath: resolve(options.auth) }),
		});
	}
	const loaded = await loadModelRoutingConfig({
		...(options.config === undefined ? {} : { configPath: resolve(options.config) }),
	});
	const credentials = new JsonFileCredentialStore({
		...(options.auth === undefined ? {} : { path: resolve(options.auth) }),
	});
	return createBuiltinModelGateway(loaded.config, { credentials, telemetryContext: cliTelemetry(io).context });
}

/** 每轮用量检查点从同一份 config.toml 读（`--config` 指定时读那份），每个 turn 开始读一次。 */
function usageCheckpoint(options: { config?: string }): () => Promise<number> {
	return () => loadUsageCheckpoint(options.config === undefined ? {} : { configPath: resolve(options.config) });
}

function cliConfigurationError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { name: "SuimCliConfigurationError", code });
}

async function cloudConnection(
	io: SuimCliIo,
	options: CloudConnectionOptions,
	boundEndpoint?: string,
): Promise<{ endpoint: string; actorId: string; store: CloudProjectStore }> {
	const defaults =
		(await io.cloudDefaults?.({
			...(options.config === undefined ? {} : { configPath: resolve(options.config) }),
		})) ?? {};
	const endpoint = options.endpoint?.trim() || boundEndpoint?.trim() || defaults.endpoint?.trim();
	if (endpoint === undefined || endpoint.length === 0) {
		throw cliConfigurationError(
			"cloud_endpoint_missing",
			"必须通过 --endpoint、本地 remote binding、SUIMING_CLOUD_ENDPOINT 或 ~/.suiming/config.toml 指定 Cloud endpoint",
		);
	}
	const actorId = options.actor?.trim() || defaults.actorId?.trim();
	if (actorId === undefined || actorId.length === 0) {
		throw cliConfigurationError(
			"cloud_actor_missing",
			"必须通过 --actor、SUIMING_CLOUD_ACTOR_ID 或 ~/.suiming/config.toml 指定 Cloud actor id",
		);
	}
	if (io.resolveCloudProjectStore === undefined) {
		throw cliConfigurationError("cloud_transport_unavailable", "这个 suim 构建没有带 Cloud transport");
	}
	return { endpoint, actorId, store: await io.resolveCloudProjectStore({ endpoint, actorId }) };
}

async function withCloudSync<T>(
	io: SuimCliIo,
	path: string,
	options: CloudConnectionOptions,
	operation: (service: LocalCloudSyncService) => Promise<T> | T,
): Promise<T> {
	return withProject(path, async (local) => {
		const connection = await cloudConnection(io, options, local.remoteBinding()?.endpoint);
		return operation(
			new LocalCloudSyncService({
				local,
				cloud: connection.store,
				endpoint: connection.endpoint,
				actorId: connection.actorId,
			}),
		);
	});
}

async function withProject<T>(path: string, operation: (service: LocalProjectService) => Promise<T> | T): Promise<T> {
	const service = await LocalProjectService.open(path);
	try {
		return await operation(service);
	} finally {
		service.close();
	}
}

export async function runSuimCli(argv: readonly string[], io: SuimCliIo): Promise<number> {
	let command: SuimCliError["command"] = "usage";
	let actionRan = false;
	let actionExitCode: number = SUIM_CLI_EXIT.success;
	const program = new Command();
	program
		.name("suim")
		.description("Suiming 本地作品命令行")
		.version(SUIM_CLI_VERSION, "-V, --version", "输出版本号")
		.helpOption("-h, --help", "显示帮助")
		.helpCommand("help [command]", "显示某个命令的帮助")
		// commander 的分节标题是内置英文；styleTitle 是它给出的唯一改写入口（本来用于上色）。
		// 这三项与 helpOption / helpCommand 一样，在建子命令之前设好才会被子命令继承。
		.configureHelp({
			styleTitle: (title) => HELP_TITLES[title] ?? title,
			displayWidth: (text) => displayColumns(text),
			commandUsage(cmd) {
				return localizeHelpFragments(Help.prototype.commandUsage.call(this, cmd));
			},
			subcommandTerm(cmd) {
				return localizeHelpFragments(Help.prototype.subcommandTerm.call(this, cmd));
			},
			optionDescription(option) {
				const text = Help.prototype.optionDescription.call(this, option);
				// commander 把 default / choices 拼成 `描述 (default: x)`，整段末尾那个右括号也是它加的。
				if (!text.includes(" (default: ")) return text;
				return `${text.replace(" (default: ", "（默认：").slice(0, -1)}）`;
			},
		})
		.option("--json", "兼容保留；响应始终是带版本的 JSON 信封")
		.option("--project <path>", "作品目录（Open Story Directory）", io.cwd())
		.exitOverride()
		.configureOutput({
			writeOut: (text) => io.stdout(text),
			writeErr: (text) => io.stderr(text),
			outputError: (text, write) => write(localizeCommanderError(text)),
		});

	const execute = async (
		selected: SuimCliCommand,
		operation: () => Promise<SuimCliSuccess["data"]>,
	): Promise<void> => {
		command = selected;
		actionRan = true;
		const data = await operation();
		outputSuccess(io, selected, data);
	};

	program
		.command("init")
		.description("初始化作品目录；补齐最小故事结构，保留已有作品和辅助文件")
		.argument("[path]")
		.option("--intent-file <path>", "从文本文件导入初始创作意图（intent/book.md）")
		.option(
			"--agent <host>",
			"同时接入 codex、claude-code 或 grok；可重复指定",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.action(async (path: string | undefined, options: { intentFile?: string; agent: string[] }) => {
			await execute("project.init", async () => {
				const hosts = [...new Set(options.agent.map(parseHostId))];
				const root = projectPath(program, path);
				const intent = options.intentFile === undefined ? undefined : await readIntentFile(options.intentFile);
				const { service, written } = await LocalProjectService.initWithStarter({
					checkoutPath: root,
					...(intent === undefined ? {} : { intent }),
				});
				try {
					const data = projectData(service);
					for (const host of hosts) written.push(...(await installHost(root, host)).written);
					return { ...data, written };
				} finally {
					service.close();
				}
			});
		});

	program
		.command("open")
		.description("校验并说明一个已初始化的 Local Project")
		.argument("[path]")
		.action(async (path?: string) => {
			await execute("project.open", () => withProject(projectPath(program, path), projectData));
		});

	program
		.command("status")
		.description("显示 checkout 状态")
		.action(async () => {
			await execute("project.status", () =>
				withProject(projectPath(program), async (service) =>
					readProjectStatus(service, await service.checkoutCandidate()),
				),
			);
		});

	program
		.command("diff")
		.description("显示 artifact 差异，不暴露 ChangeSet 输入")
		.action(async () => {
			await execute("project.diff", () =>
				withProject(projectPath(program), async (service) => diffData(await service.diff())),
			);
		});

	program
		.command("check")
		.description("对 checkout 候选跑确定性 Story 检查")
		.action(async () => {
			await execute("project.check", () =>
				withProject(projectPath(program), async (service) => {
					return checkSummary(await service.check());
				}),
			);
		});

	program
		.command("commit")
		.description("检查并提交 checkout 的实际差异")
		.action(async () => {
			await execute("project.commit", () =>
				withProject(projectPath(program), async (service) => {
					return commitResult(await service.commitCheckout());
				}),
			);
		});

	program
		.command("history")
		.description("显示本地 ProjectRevision 历史")
		.action(async () => {
			await execute("project.history", () =>
				withProject(projectPath(program), async (service) => ({
					projectId: service.projectId,
					headRevisionId: service.project().headRevisionId,
					revisions: (await service.history()).map(revisionSummary),
				})),
			);
		});

	program
		.command("rollback")
		.description("把某个历史 revision 恢复成一个新的已提交 revision")
		.argument("<revision-id>")
		.action(async (revisionId: string) => {
			await execute("project.rollback", () =>
				withProject(projectPath(program), async (service) => {
					return rollbackResult(await service.rollbackRevision(revisionId));
				}),
			);
		});

	program
		.command("export")
		.description("把某个已提交 revision 导出成一个新的 Open Story Directory")
		.argument("<output>")
		.option("--revision <id>")
		.action(async (output: string, options: { revision?: string }) => {
			await execute("project.export", () =>
				withProject(projectPath(program), async (service) => {
					const revisionId = options.revision ?? service.project().headRevisionId;
					const outputPath = resolve(output);
					const files = await service.exportRevision(revisionId);
					await service.materializeRevision(outputPath, revisionId);
					return { projectId: service.projectId, revisionId, outputPath, fileCount: files.length };
				}),
			);
		});

	program
		.command("update")
		.description("刷新当前作品已安装的接入文件，保留作者模型配置；不升级程序或修改作品内容")
		.option(
			"--agent <host>",
			"补接或指定刷新 codex、claude-code 或 grok；可重复指定",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.action(async (options: { agent: string[] }) => {
			const requested = [...new Set(options.agent.map(parseHostId))];
			await execute("project.update", () =>
				withProject(projectPath(program), async (service) => {
					const hosts = requested.length > 0 ? requested : await installedHosts(service.paths.checkoutPath);
					if (hosts.length === 0)
						throw new ArtifactError(
							"invalid_cli_usage",
							"尚未接入任何 host；请用 suim update --agent grok（或 codex、claude-code）指定。",
						);
					const updated = [];
					for (const host of hosts) updated.push(await installHost(service.paths.checkoutPath, host));
					return { projectId: service.projectId, hosts: updated };
				}),
			);
		});

	program
		.command("search")
		.description("检索已提交的 Story Artifact，命中绑定到具体 revision")
		.argument("<query>")
		.option("--kind <kind...>")
		.option("--source <sourceId>")
		.option("--limit <count>", "最多返回几条命中", (value) => Number(value))
		.option("--revision <id>")
		.action(
			async (query: string, options: { kind?: string[]; source?: string; limit?: number; revision?: string }) => {
				await execute("read.search", () =>
					withProject(projectPath(program), (service) =>
						service.search(
							{
								query,
								namespace:
									options.source === undefined
										? { kind: "target" }
										: { kind: "source", sourceId: options.source },
								...(options.kind === undefined ? {} : { kinds: options.kind }),
								...(options.limit === undefined ? {} : { limit: options.limit }),
							},
							options.revision,
						),
					),
				);
			},
		);

	const context = program.command("context").description("为一次任务编译 host agent 需要的 Context");
	context
		.command("compile")
		.description(
			"为一次任务编译按需裁剪的 Context（write:<beat-id>、design、design:state:<beat-id>:before|changes|after[:character|resource|contract:<id>]、design:character:<id>[:at:<beat-id>]、design:family:<id>、design:volume:<id>、source:read:<source-id>[:<start>:<end>]、review:design、review:text[:<beat-id>,...]、review:source:<source-id>）；输入按路径引用作品文件",
		)
		.argument("<task>")
		.option("--output <path>", "同时把输入文本写到这个文件")
		.action(async (task: string, options: { output?: string }) => {
			await execute("context.compile", () =>
				withProject(projectPath(program), async (service) => {
					const compiled = await compileHostContext(service, task);
					let outputPath: string | undefined;
					if (options.output !== undefined) {
						outputPath = resolve(io.cwd(), options.output);
						await mkdir(dirname(outputPath), { recursive: true });
						await writeFile(outputPath, compiled.text);
					}
					return {
						projectId: service.projectId,
						revisionId: compiled.revisionId,
						task: compiled.task,
						systemPrompt: compiled.systemPrompt,
						text: compiled.text,
						artifacts: compiled.artifacts,
						...(outputPath === undefined ? {} : { outputPath }),
						...(compiled.write === undefined ? {} : { write: compiled.write }),
						...(compiled.review === undefined ? {} : { review: compiled.review }),
						...(compiled.design === undefined ? {} : { design: compiled.design }),
						...(compiled.source === undefined ? {} : { source: compiled.source }),
					};
				}),
			);
		});

	const text = program.command("text").description("对当前 checkout 里的 StoryText 做确定性检查");
	text
		.command("check")
		.description("在 checkout 上跑单个 Beat 的 StoryText 检查（文件在不在、Design 绑没绑、Intent 片段是否逐字出现）")
		.argument("<beat-id>")
		.action(async (storyBeatId: string) => {
			await execute("text.check", () =>
				withProject(projectPath(program), async (service) => {
					const status = await service.status();
					const check = checkStoryText(await service.checkoutCandidate(), storyBeatId);
					return {
						projectId: service.projectId,
						baseRevisionId: status.baseRevisionId,
						state: status.state,
						storyBeatId,
						passed: check.passed,
						codePoints: check.codePoints,
						failures: check.failures,
					};
				}),
			);
		});

	const design = program.command("design").description("查询 Story Design 的 schema 与改动影响");
	design
		.command("guide")
		.description("打印 Target 的 Story Language 机器形状（frontmatter 字段与硬状态属性），由当前 schema 渲染")
		.action(async () => {
			await execute("design.guide", async () => ({ guide: renderTargetStoryLanguageSchemaGuide() }));
		});
	design
		.command("impact")
		.description(
			"列出改动 <kind>:<id> 可能波及的 Design 与 StoryText（beat、character、place、resource、world、contract、intent）；只是召回，不是闸",
		)
		.argument("<subject>")
		.option("--source <sourceId>", "查这份 Source 的抽取；缺省查 Target")
		.action(async (subject: string, options: { source?: string }) => {
			await execute("design.impact", () =>
				withProject(projectPath(program), async (service) => {
					const status = await service.status();
					return {
						projectId: service.projectId,
						baseRevisionId: status.baseRevisionId,
						state: status.state,
						impact: storyImpact(
							await service.checkoutCandidate(),
							parseStoryImpactSubject(subject),
							options.source,
						),
					};
				}),
			);
		});
	const source = program.command("source").description("导入 Source 材料并查看阅读覆盖率");
	source
		.command("ingest")
		.description("把一个本地文本文件导入为不可变的 Source 输入与可读材料")
		.argument("<input>")
		.requiredOption("--id <source-id>", "作品内的 Source id")
		.option("--name <name>", "显示名；默认取输入文件名")
		.option("--encoding <encoding>", "utf-8、gb18030、gbk、big5、utf-16le 或 utf-16be")
		.action(async (input: string, options: { id: string; name?: string; encoding?: string }) => {
			await execute("source.ingest", () =>
				withProject(projectPath(program), async (service) => {
					const inputPath = resolve(io.cwd(), input);
					const ingested = await service.ingestSource({
						sourceId: options.id,
						name: options.name ?? basename(inputPath),
						original: await readSourceInput(inputPath),
						...(options.encoding === undefined ? {} : { encoding: options.encoding }),
					});
					return {
						projectId: service.projectId,
						revision: revisionSummary(ingested.revision),
						source: sourceSummaryData(ingested.source),
					};
				}),
			);
		});

	source
		.command("list")
		.description("列出已提交的 Source、各自的抽取状态，以及笔记覆盖了多少材料")
		.action(async () => {
			await execute("source.list", () =>
				withProject(projectPath(program), async (service) => {
					const session = await service.openRuntimeSession();
					const candidate = session.artifacts.snapshotForProject(service.projectId, session.memoryRevisionId);
					const sources = inspectStorySourcesCandidate(candidate).map((item) =>
						sourceSummaryData(item, sourceCoverage(candidate, item.sourceId)),
					);
					return { projectId: service.projectId, revisionId: service.project().headRevisionId, sources };
				}),
			);
		});

	const review = program.command("review").description("读取与记录审稿文件（review/<id>.md）");
	review
		.command("list")
		.description("列出已提交 revision 里的审稿文件，以及每份还算不算数")
		.action(async () => {
			await execute("review.list", () =>
				withProject(projectPath(program), async (service) => {
					const { revisionId, reviews } = await committedReviews(service);
					return { projectId: service.projectId, revisionId, reviews: reviews.map((item) => item.summary) };
				}),
			);
		});

	review
		.command("show")
		.description("显示某份已提交的审稿文件与完整 ReviewDraft")
		.argument("<review-id>")
		.action(async (reviewId: string) => {
			await execute("review.show", () =>
				withProject(projectPath(program), async (service) => {
					const { revisionId, reviews } = await committedReviews(service);
					const item = reviews.find(({ review }) => review.id === reviewId);
					if (item === undefined) throw new ArtifactError("review_not_found", reviewId);
					return {
						projectId: service.projectId,
						revisionId,
						review: { ...item.summary, draft: item.review.file.draft },
					};
				}),
			);
		});

	review
		.command("schema")
		.description("打印 ReviewDraft 的 JSON Schema，供支持结构化输出的 host 使用")
		.action(async () => {
			await execute("review.schema", async () => ({
				schema: JSON.parse(JSON.stringify(ReviewDraftSchema)) as Record<string, unknown>,
			}));
		});

	review
		.command("record")
		.description(
			"按已提交 revision 校验 host 产出的 ReviewDraft，写成 review/<id>.md 放进 checkout；用 `suim commit` 提交",
		)
		.argument("<draft-file>", "存放 ReviewDraft 的 JSON 文件")
		.requiredOption("--layer <layer>", "design、source 或 text")
		.option("--source <source-id>", "--layer source 时指定的 Source id")
		.option("--beat <id...>", "把 text 审稿限定到这些 StoryBeat")
		.action(async (draftFile: string, options: { layer: string; source?: string; beat?: string[] }) => {
			await execute("review.record", () =>
				withProject(projectPath(program), async (service) => {
					if (options.layer !== "design" && options.layer !== "source" && options.layer !== "text") {
						throw new ArtifactError("invalid_review_subject", "--layer 只能是 design、source 或 text");
					}
					const draft = JSON.parse(await readFile(resolve(io.cwd(), draftFile), "utf8")) as unknown;
					const composed = await composeHostReview(service, {
						draft,
						layer: options.layer,
						...(options.source === undefined ? {} : { sourceId: options.source }),
						...(options.beat === undefined ? {} : { scope: { kind: "selection", storyBeatIds: options.beat } }),
					});
					const target = resolve(service.project().checkoutPath, composed.path);
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, composed.content, { flag: "wx" });
					return {
						projectId: service.projectId,
						revisionId: service.project().headRevisionId,
						review: reviewSummary(
							{ id: composed.id, path: composed.path, file: composed.file },
							{ state: "current", changed: [] },
						),
					};
				}),
			);
		});

	const release = program.command("release").description("查看与发布确定性的 Release artifact");
	release
		.command("status")
		.description("查看已提交的 Release 是否还与当前 StoryText 及其审稿一致")
		.action(async () => {
			await execute("release.status", () =>
				withProject(projectPath(program), async (service) => {
					const head = service.project().headRevisionId;
					const reader = service.historyReader();
					return {
						projectId: service.projectId,
						revisionId: head,
						...(await inspectRelease(reader, head, await reader.snapshot(head))),
					};
				}),
			);
		});

	release
		.command("publish")
		.description("从完整且当前的 StoryText 精确推导出 Release 并提交")
		.option("--review <id>", "绑定一份仍然算数的全书 StoryText 审稿（review/<id>.md）")
		.option("--target-code-points <count>", "目标章节长度", Number)
		.option("--min-code-points <count>", "最小章节长度", Number)
		.option("--max-code-points <count>", "最大章节长度", Number)
		.action(
			async (options: {
				review?: string;
				targetCodePoints?: number;
				minCodePoints?: number;
				maxCodePoints?: number;
			}) => {
				await execute("release.publish", () =>
					withProject(projectPath(program), async (service) => {
						const head = service.project().headRevisionId;
						const reader = service.historyReader();
						const candidate = await reader.snapshot(head);
						const published = await publishRelease(reader, {
							candidate,
							headRevisionId: head,
							...(options.review === undefined ? {} : { storyTextReview: options.review }),
							...(options.targetCodePoints === undefined ? {} : { targetCodePoints: options.targetCodePoints }),
							...(options.minCodePoints === undefined ? {} : { minCodePoints: options.minCodePoints }),
							...(options.maxCodePoints === undefined ? {} : { maxCodePoints: options.maxCodePoints }),
						});
						// 重复发布得到同一份 Release（章节、审稿绑定、切分都没变）就不再产生 revision；
						// manifest 的 revision 每次都会是新 head，不参与比较。
						const existingManifest = candidate.artifacts.find(
							(artifact) => artifact.identity.kind === "release-manifest",
						);
						let unchanged = false;
						if (existingManifest !== undefined) {
							try {
								const previous = parseReleaseManifest(
									parseYaml(new TextDecoder().decode(existingManifest.bytes), "release/manifest.yaml"),
								);
								unchanged =
									canonicalJson({ ...previous, revision: "" }) ===
									canonicalJson({ ...published.manifest, revision: "" });
							} catch {
								unchanged = false;
							}
						}
						const revision = unchanged
							? (await service.history()).find((item) => item.id === head)
							: await service.commitManagedChangeSet({ baseRevisionId: head, operations: published.operations });
						if (revision === undefined) throw new ArtifactError("revision_not_found", head);
						return {
							projectId: service.projectId,
							created: !unchanged,
							revision: revisionSummary(revision),
							manifest: {
								path: "release/manifest.yaml",
								revision: published.manifest.revision,
								...(published.manifest.storyTextReview === undefined
									? {}
									: { storyTextReview: published.manifest.storyTextReview }),
								layout: published.manifest.layout,
								chapters: published.manifest.chapters.map((chapter) => ({
									id: chapter.id,
									path: chapter.path,
									codePoints: chapter.codePoints,
									sha256: chapter.sha256,
								})),
							},
							...(published.reviewVerdict === undefined ? {} : { reviewVerdict: published.reviewVerdict }),
						};
					}),
				);
			},
		);

	const session = program.command("session").description("与 Suiming Agent 对话：一个 session 就是一份连续的消息列表");
	session
		.command("send")
		.description("发一条作者消息并等这个 turn 结束；不带 --session 就新开一个 session")
		.argument("<text...>")
		.option("--session <id>", "继续一个已有的 session")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.option("--auth <path>", "覆盖 ~/.suiming/auth.json")
		.option("--events", "在最终响应之前逐行流式输出 SessionEvent NDJSON")
		.action(
			async (words: string[], options: { session?: string; config?: string; auth?: string; events?: boolean }) => {
				await execute("session.send", () =>
					withProject(projectPath(program), async (service) => {
						const models = await modelGateway(io, options);
						const controller = new LocalSessionController({
							project: service,
							models,
							telemetryContext: cliTelemetry(io).context,
							usageCheckpoint: usageCheckpoint(options),
						});
						const onEvent = eventWriter(io, "session.send", options.events === true);
						const sent = await controller.send({
							commandId: randomUUID(),
							text: words.join(" "),
							...(options.session === undefined ? {} : { sessionId: options.session }),
							...(onEvent === undefined ? {} : { onEvent }),
						});
						await withInterrupt(io, async (signal) => {
							signal.addEventListener(
								"abort",
								() => {
									try {
										controller.interrupt(sent.sessionId, "Interrupted by signal");
									} catch {
										// 不由本进程持有时无事可停。
									}
								},
								{ once: true },
							);
							await controller.completion(sent.sessionId);
							// 作者按了 Ctrl+C：turn 已收口回 idle，消息列表与工作区保留；退出码要如实说是中断，不是完成。
							if (signal.aborted)
								throw new ArtifactError("run_interrupted", "当前 turn 已被中断；再发一条消息即可接着跑");
						});
						return sessionTurnData(service, sent.sessionId);
					}),
				);
			},
		);

	session
		.command("resume")
		.description("作者核对过暂停原因之后，继续一个 paused 的 session")
		.argument("<session-id>")
		.option("--retry-unknown", "显式重发一个结果未知的模型请求")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.option("--auth <path>", "覆盖 ~/.suiming/auth.json")
		.option("--events", "在最终响应之前逐行流式输出 SessionEvent NDJSON")
		.action(
			async (
				sessionId: string,
				options: { retryUnknown?: boolean; config?: string; auth?: string; events?: boolean },
			) => {
				await execute("session.resume", () =>
					withProject(projectPath(program), async (service) => {
						const models = await modelGateway(io, options);
						const controller = new LocalSessionController({
							project: service,
							models,
							telemetryContext: cliTelemetry(io).context,
							usageCheckpoint: usageCheckpoint(options),
						});
						const onEvent = eventWriter(io, "session.resume", options.events === true);
						await controller.resume({
							commandId: randomUUID(),
							sessionId,
							retryUnknownModelCall: options.retryUnknown === true,
							...(onEvent === undefined ? {} : { onEvent }),
						});
						await withInterrupt(io, async (signal) => {
							signal.addEventListener(
								"abort",
								() => {
									try {
										controller.interrupt(sessionId, "Interrupted by signal");
									} catch {
										// 不由本进程持有时无事可停。
									}
								},
								{ once: true },
							);
							await controller.completion(sessionId);
							if (signal.aborted)
								throw new ArtifactError("run_interrupted", "当前 turn 已被中断；再发一条消息即可接着跑");
						});
						return sessionTurnData(service, sessionId);
					}),
				);
			},
		);

	session
		.command("interrupt")
		.description("放弃 paused session 的这次核对、回 idle；正在跑的 turn 只能在跑它的进程里停")
		.argument("<session-id>")
		.action(async (sessionId: string) => {
			await execute("session.interrupt", () =>
				withProject(projectPath(program), (service) => {
					const snapshot = service.loadExecutionEntities();
					const record = snapshot.sessions.find((item) => item.id === sessionId);
					if (record === undefined)
						throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
					// 每次 suim 调用都是新进程，不可能持有一个正在跑的 turn：那只能在跑它的进程里停，如实报错。
					if (record.status === "running") throw notActiveInProcess(sessionId);
					abandonPausedSession(service, sessionId);
					const settled = service.loadExecutionEntities();
					const current = settled.sessions.find((item) => item.id === sessionId) ?? record;
					return {
						projectId: service.projectId,
						session: sessionSummary(current, sessionTitle(service, sessionId)),
					};
				}),
			);
		});

	session
		.command("list")
		.description("列出这个 Local Project 持久化的 session")
		.action(async () => {
			await execute("session.list", () =>
				withProject(projectPath(program), (service) => ({
					projectId: service.projectId,
					sessions: sessionSummaries(service.loadExecutionEntities(), (id) => sessionTitle(service, id)),
				})),
			);
		});

	session
		.command("show")
		.description("显示某个 session 及它的子任务")
		.argument("<session-id>")
		.action(async (sessionId: string) => {
			await execute("session.show", () =>
				withProject(projectPath(program), (service) => ({
					projectId: service.projectId,
					...sessionShowData(service, sessionId),
				})),
			);
		});

	session
		.command("events")
		.description("读取某个 session 持久化的 SessionEvent")
		.argument("<session-id>")
		.option("--after <sequence>", "只取序号大于它的事件", Number)
		.action(async (sessionId: string, options: { after?: number }) => {
			await execute("session.events", () =>
				withProject(projectPath(program), (service) => {
					if (!service.loadExecutionEntities().sessions.some((session) => session.id === sessionId)) {
						throw new ArtifactError("execution_not_found", `Session not found: ${sessionId}`);
					}
					const after = options.after ?? 0;
					if (!Number.isInteger(after) || after < 0) {
						throw new ArtifactError("invalid_argument", "--after 必须是非负整数");
					}
					return { projectId: service.projectId, sessionId, events: service.readSessionEvents(sessionId, after) };
				}),
			);
		});

	program
		.command("rank")
		.description("用隔离的评委盲评同一个 StoryBeat 的多份候选（judge profile，候选打乱且匿名，每种顺序跑一轮）")
		.argument("<beat-id>")
		.requiredOption("--candidate <file...>", "候选 StoryText 文件；去掉扩展名的文件名就是它的标签")
		.option("--rounds <count>", "让评委看几种候选顺序（1-4）", "2")
		.option("--goal <text>", "这次想比较什么")
		.option(
			"--rubric <rubric>",
			"评委口径：constitution 按本作宪法与写作准则评本作的几份候选；reader 不带本作准则、只给前文，看哪一版更像这部书接着往下写（对照原作或参照稿时用）",
			"constitution",
		)
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.option("--auth <path>", "覆盖 ~/.suiming/auth.json")
		.option("--events", "在最终响应之前逐行流式输出 SessionEvent NDJSON")
		.action(
			async (
				storyBeatId: string,
				options: {
					candidate: string[];
					rounds: string;
					goal?: string;
					rubric: string;
					config?: string;
					auth?: string;
					events?: boolean;
				},
			) => {
				await execute("rank", () =>
					withProject(projectPath(program), async (service) => {
						const rounds = Number.parseInt(options.rounds, 10);
						if (!Number.isInteger(rounds) || rounds < 1 || rounds > 4) {
							throw new ArtifactError("invalid_cli_usage", "--rounds 必须是 1 到 4 的整数");
						}
						if (!RANK_RUBRICS.includes(options.rubric as RankRubric)) {
							throw new ArtifactError("invalid_cli_usage", `--rubric 只能是 ${RANK_RUBRICS.join(" 或 ")}`);
						}
						const candidates = await Promise.all(
							options.candidate.map(async (file) => {
								const path = resolve(io.cwd(), file);
								return { label: basename(path).replace(/\.[^.]+$/u, ""), text: await readFile(path, "utf8") };
							}),
						);
						const models = await modelGateway(io, options);
						const onEvent = eventWriter(io, "rank", options.events === true);
						const result = await withInterrupt(io, (signal) =>
							runRankExperiment(suimingHarness(io, service, models), {
								signal,
								storyBeatId,
								candidates,
								rounds,
								rubric: options.rubric as RankRubric,
								...(options.goal === undefined ? {} : { goal: options.goal }),
								...(onEvent === undefined ? {} : { onEvent }),
							}),
						);
						return localRankData(service, result);
					}),
				);
			},
		);

	const cloud = program.command("cloud").description("与 Suiming Cloud 同步已提交的 revision");
	cloud
		.command("checkout")
		.description("从某个已提交的 Cloud revision 建立 Local Project 的 checkout")
		.argument("<cloud-project-id>")
		.argument("<destination>")
		.option("--endpoint <url>", "Cloud Domain API 地址")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.option("--revision <id>", "要 checkout 的 Cloud ProjectRevision")
		.option("--local-project-id <id>", "显式指定 Local Project id")
		.action(
			async (
				cloudProjectId: string,
				destination: string,
				options: CloudConnectionOptions & { revision?: string; localProjectId?: string },
			) => {
				await execute("cloud.checkout", async () => {
					const connection = await cloudConnection(io, options);
					const checkedOut = await LocalCloudSyncService.checkout({
						cloud: connection.store,
						endpoint: connection.endpoint,
						actorId: connection.actorId,
						cloudProjectId,
						destinationPath: resolve(io.cwd(), destination),
						...(options.revision === undefined ? {} : { cloudRevisionId: options.revision }),
						...(options.localProjectId === undefined ? {} : { localProjectId: options.localProjectId }),
					});
					try {
						return {
							project: projectData(checkedOut.local),
							binding: checkedOut.binding,
							cloudRevision: revisionSummary(checkedOut.cloudRevision),
						};
					} finally {
						checkedOut.local.close();
					}
				});
			},
		);

	cloud
		.command("import")
		.description("用本地已提交的 head 创建 Cloud Project 并绑定")
		.argument("<cloud-project-id>")
		.option("--endpoint <url>", "Cloud Domain API 地址")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.requiredOption("--idempotency-key <key>", "可安全重试请求的稳定 key")
		.option("--allow-dirty", "忽略只在 checkout 里的修改，导入本地已提交的 head")
		.action(
			async (
				cloudProjectId: string,
				options: CloudConnectionOptions & { idempotencyKey: string; allowDirty?: boolean },
			) => {
				await execute("cloud.import", () =>
					withCloudSync(io, projectPath(program), options, async (service) => {
						const imported = await service.import({
							cloudProjectId,
							idempotencyKey: options.idempotencyKey,
							...(options.allowDirty === true ? { allowDirtyCheckout: true } : {}),
						});
						return { binding: imported.binding, revision: revisionSummary(imported.revision) };
					}),
				);
			},
		);

	cloud
		.command("link")
		.description("绑定内容相同的本地与 Cloud 已提交 revision")
		.argument("<cloud-project-id>")
		.option("--endpoint <url>", "Cloud Domain API 地址")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.option("--revision <id>", "要绑定的 Cloud ProjectRevision")
		.action(async (cloudProjectId: string, options: CloudConnectionOptions & { revision?: string }) => {
			await execute("cloud.link", () =>
				withCloudSync(io, projectPath(program), options, async (service) => ({
					binding: await service.link({
						cloudProjectId,
						...(options.revision === undefined ? {} : { cloudRevisionId: options.revision }),
					}),
				})),
			);
		});

	cloud
		.command("status")
		.description("比较本地与 Cloud 的已提交 head")
		.option("--endpoint <url>", "覆盖已绑定的 Cloud endpoint")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.action(async (options: CloudConnectionOptions) => {
			await execute("cloud.status", () =>
				withCloudSync(io, projectPath(program), options, (service) => service.status()),
			);
		});

	cloud
		.command("push")
		.description("推送本地已提交的 revision，并合并互不重叠的 Cloud 改动")
		.option("--endpoint <url>", "覆盖已绑定的 Cloud endpoint")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.requiredOption("--idempotency-key <key>", "可安全重试请求的稳定 key")
		.option("--allow-dirty", "忽略只在 checkout 里的修改，推送本地已提交的 head")
		.action(async (options: CloudConnectionOptions & { idempotencyKey: string; allowDirty?: boolean }) => {
			await execute("cloud.push", () =>
				withCloudSync(io, projectPath(program), options, (service) =>
					service.push({
						idempotencyKey: options.idempotencyKey,
						...(options.allowDirty === true ? { allowDirtyCheckout: true } : {}),
					}),
				),
			);
		});

	cloud
		.command("pull")
		.description("把 Cloud 的已提交改动拉进干净的本地 checkout")
		.option("--endpoint <url>", "覆盖已绑定的 Cloud endpoint")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.action(async (options: CloudConnectionOptions) => {
			await execute("cloud.pull", () =>
				withCloudSync(io, projectPath(program), options, (service) => service.pull()),
			);
		});

	cloud
		.command("unlink")
		.description("解除本地的 remote binding，两边的 Project 都不删除")
		.option("--endpoint <url>", "覆盖已绑定的 Cloud endpoint")
		.option("--actor <id>", "已认证的 Cloud actor id")
		.option("--config <path>", "覆盖 ~/.suiming/config.toml")
		.action(async (options: CloudConnectionOptions) => {
			await execute("cloud.unlink", () =>
				withCloudSync(io, projectPath(program), options, (service) => ({ binding: service.unlink() })),
			);
		});

	try {
		await program.parseAsync([...argv], { from: "user" });
		if (!actionRan) {
			const value: CommandFailure = {
				code: "command_required",
				message: "带了全局选项就必须再给一个子命令",
				retryable: false,
				exitCode: SUIM_CLI_EXIT.usage,
			};
			outputFailure(io, "usage", value);
			return value.exitCode;
		}
		return actionExitCode;
	} catch (error) {
		const value = failure(error);
		actionExitCode = value.exitCode;
		if (!commanderDisplayedOutput(error)) outputFailure(io, command, value);
		return actionExitCode;
	} finally {
		// 短命进程：退出前有界等待 span 导出，超时也放行。
		const telemetry = telemetryByIo.get(io);
		telemetryByIo.delete(io);
		if (telemetry !== undefined) {
			await telemetry.shutdown();
		}
	}
}
