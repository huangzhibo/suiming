import { createHash } from "node:crypto";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
	LOCAL_COMMANDS,
	type LocalCommandClient,
	type LocalCommandInput,
	type LocalCommandName,
	type LocalCommandOutput,
	type WorkspaceChange,
} from "@suiming/sdk";
import {
	canonicalJson,
	compareCodeUnits,
	parseMarkdownDocument,
	parseStoryIndexYaml,
	parseYaml,
	TARGET_DESIGN_KINDS,
} from "@suiming/story";
import { Value } from "typebox/value";
import { codePointCount } from "../artifact/code-points.js";
import { type TextCurrency, textCurrencies } from "../artifact/derived.js";
import { ArtifactError } from "../artifact/errors.js";
import type { OpenPackageFile } from "../artifact/open-package.js";
import { OpenStoryDirectoryCache, readOpenStoryDirectory } from "../artifact/open-story-directory.js";
import { commitResult, rollbackResult } from "../artifact/revision-summary.js";
import { storyPackageCodec } from "../artifact/story-package-codec.js";
import { sessionSummaries, taskSummaries } from "../execution/session-summary.js";
import { compileDesignViewContext } from "../harness/design-view-context.js";
import { productEventSnapshot } from "../harness/event-snapshot.js";
import { parseHostContextTask } from "../harness/host-context.js";
import { compileWriteContext } from "../harness/write-context.js";
import { LocalModelSettings } from "../model/local-model-settings.js";
import type { ModelGateway } from "../model/model-gateway.js";
import { checkSummary } from "./check-summary.js";
import type { LocalProjectService } from "./local-project-service.js";
import { abandonPausedSession, LocalSessionController } from "./local-session-controller.js";
import {
	listProjectFiles,
	readProjectFile,
	resolveProjectFile,
	revisionFileView,
	saveProjectFile,
} from "./project-files.js";
import { committedReviews } from "./review-summary.js";

/** 作者点「停止」后最多等这么久确认收口；超时如实回当前状态，不硬取消也不挂死界面。 */
const CANCEL_SETTLE_TIMEOUT_MS = 5_000;

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** git 的 blob id：与 historyReader().fileDigests 同一口径，比对 checkout 与已提交版本不用把版本整份读出来。 */
const blobId = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
/** 目录投影与 diff 把哪些 mediaType 当文本：Markdown、YAML、JSON 都是作者可读的作品文件。 */
const textual = (mediaType: string) => mediaType.startsWith("text/") || /yaml|json/u.test(mediaType);
const STORY_INDEX_PATH = "outline/story/index.yaml";
type TextProjection = { storyText: TextCurrency[]; derivedError?: string };

/** 两侧 blob id 不同的作品文件，按路径排序；只比摘要，不读正文。 */
function changedFiles(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
): LocalCommandOutput<"project.diff"> {
	return [...new Set([...before.keys(), ...after.keys()])].sort(compareCodeUnits).flatMap((path) => {
		const a = before.get(path);
		const b = after.get(path);
		if (a === b) return [];
		return [
			{
				path,
				kind: a === undefined ? ("added" as const) : b === undefined ? ("deleted" as const) : ("modified" as const),
			},
		];
	});
}

type ShownFile = LocalCommandOutput<"workspace.show">["files"][number];
type StoryIndexView =
	| { volumes: LocalCommandOutput<"workspace.show">["volumes"]; openEnded: boolean }
	| { error: string };
/** 一个作品文件在目录投影里的样子，与它提没提交无关；`index` 只有 index.yaml 有。 */
interface FileProjection {
	blobId: string;
	file: Omit<ShownFile, "dirty">;
	index?: StoryIndexView;
}

/** 目录投影尽力解析：编码或 frontmatter 坏了仍列出文件，由 Checker 在检查 / 提交时给出准确诊断。 */
function projectStoryFile(file: OpenPackageFile): FileProjection {
	const identity = storyPackageCodec.identityForPath(file.path);
	let text: string | undefined;
	if (textual(file.mediaType)) {
		try {
			text = decode(file.bytes);
		} catch {
			text = undefined;
		}
	}
	let frontmatter: Record<string, unknown> = {};
	let heading: string | undefined;
	if (text !== undefined && file.path.endsWith(".md")) {
		try {
			const document = parseMarkdownDocument(text, file.path);
			frontmatter = document.frontmatter;
			heading = /^#[ \t]+(.+?)[ \t#]*$/mu.exec(document.body)?.[1];
		} catch {
			frontmatter = {};
		}
	}
	let index: StoryIndexView | undefined;
	if (file.path === STORY_INDEX_PATH) {
		try {
			if (text === undefined) throw new Error("index.yaml 不是有效的 UTF-8 文本");
			const parsed = parseStoryIndexYaml(parseYaml(text, file.path));
			index = {
				volumes: parsed.volumes.map((volume) => ({
					id: volume.id,
					title: volume.title,
					beatIds: [...volume.beatIds],
				})),
				openEnded: parsed.openEnded,
			};
		} catch (error) {
			index = { error: error instanceof Error ? error.message : String(error) };
		}
	}
	const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;
	return {
		blobId: blobId(file.bytes),
		file: {
			path: file.path,
			kind: identity.kind,
			localId: identity.localId,
			namespace: identity.namespace.kind === "target" ? "target" : identity.namespace.sourceId,
			codePoints: text === undefined ? 0 : codePointCount(text),
			...(title === undefined ? {} : { title }),
			...(heading === undefined ? {} : { heading }),
			frontmatter,
		},
		...(index === undefined ? {} : { index }),
	};
}

/** 本地作者工作台的应用服务。作品仍是 checkout / revision，窗口只保留编辑 buffer 与 view state。 */
export class LocalWorkspace implements LocalCommandClient {
	readonly project: LocalProjectService;
	readonly #models: () => Promise<ModelGateway>;
	readonly #settings: LocalModelSettings;
	readonly #systemFile: ((absolute: string, action: "reveal" | "open") => Promise<void>) | undefined;
	#sessions: LocalSessionController | undefined;
	#unsubscribeExecution: (() => void) | undefined;
	#modelsChanged = false;
	/** 与 #sessions 同一次初始化得到的 gateway；启动预检用它，不再另开一次模型初始化。 */
	#gateway: ModelGateway | undefined;
	#loadingController: Promise<LocalSessionController> | undefined;
	readonly #pending = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
	/** 正文时效投影只随已提交版本变化；按 head 缓存，避免每次 show 都从 git 历史重新派生。 */
	#textProjection: { revisionId: string; value: Promise<TextProjection> } | undefined;
	readonly #listeners = new Set<(change: WorkspaceChange) => void>();
	/** 视图查询（show 与未提交 diff）读目录走它，检查与提交不走，见 OpenStoryDirectoryCache。 */
	readonly #directoryCache = new OpenStoryDirectoryCache();
	/** 按字节对象记住每个文件的投影：目录缓存对没变的文件返回同一个对象，于是不再每 100ms 重解码、重解析。 */
	readonly #projections = new WeakMap<Uint8Array, FileProjection>();
	#projection(file: OpenPackageFile): FileProjection {
		const known = this.#projections.get(file.bytes);
		if (known?.file.path === file.path) return known;
		const projection = projectStoryFile(file);
		this.#projections.set(file.bytes, projection);
		return projection;
	}
	constructor(
		project: LocalProjectService,
		models: () => Promise<ModelGateway>,
		settings = new LocalModelSettings(),
		systemFile?: (absolute: string, action: "reveal" | "open") => Promise<void>,
		private readonly telemetryContext?: TelemetryContext,
	) {
		this.project = project;
		this.#models = models;
		this.#settings = settings;
		this.#systemFile = systemFile;
	}
	onChange(listener: (change: WorkspaceChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	#changed(change: WorkspaceChange = "workspace"): void {
		for (const listener of this.#listeners) {
			try {
				listener(change);
			} catch {
				/* 已确认操作不受窗口影响 */
			}
		}
	}
	async #controller(): Promise<LocalSessionController> {
		if (this.#modelsChanged && !this.#sessions?.isBusy() && !this.#loadingController) {
			this.#unsubscribeExecution?.();
			this.#unsubscribeExecution = undefined;
			this.#sessions = undefined;
			this.#gateway = undefined;
			this.#modelsChanged = false;
		}
		if (this.#sessions) return this.#sessions;
		this.#loadingController ??= this.#models()
			.then((models) => {
				this.#gateway = models;
				this.#sessions = new LocalSessionController({
					project: this.project,
					models,
					...(this.telemetryContext === undefined ? {} : { telemetryContext: this.telemetryContext }),
				});
				this.#unsubscribeExecution = this.#sessions.subscribe(() => this.#changed("execution"));
				return this.#sessions;
			})
			.finally(() => {
				this.#loadingController = undefined;
			});
		return this.#loadingController;
	}
	activeSessionIds(): string[] {
		return this.#sessions?.activeSessionIds() ?? [];
	}
	async shutdown(): Promise<void> {
		this.#unsubscribeExecution?.();
		this.#unsubscribeExecution = undefined;
		if (this.#sessions) {
			for (const id of this.#sessions.activeSessionIds()) this.#sessions.interrupt(id, "应用退出，已请求保存进度");
			await this.#sessions.waitForIdle();
		}
	}
	async invoke<K extends LocalCommandName>(command: K, input: LocalCommandInput<K>): Promise<LocalCommandOutput<K>> {
		const spec = LOCAL_COMMANDS[command];
		if (!spec || !Value.Check(spec.input, input)) throw new ArtifactError("invalid_command_input", command);
		const output = await this.#execute(command, input);
		if (!Value.Check(spec.output, output)) throw new ArtifactError("invalid_command_result", command);
		return output as LocalCommandOutput<K>;
	}
	async #execute(command: LocalCommandName, input: unknown): Promise<unknown> {
		const project = this.project;
		// 桌面的每条作品命令先从 canon ref 重读 head：CLI 与 host 的 suim commit 在别的进程里推进它，
		// 不重读的话已提交的文件会一直标成未提交，桌面里提交也会因基线过期被拒。模型设置不读作品。
		if (!command.startsWith("models.")) await project.refreshHead();
		switch (command) {
			case "session.list":
				return { projectId: project.projectId, sessions: this.#sessionList() };
			case "workspace.files":
				return {
					projectId: project.projectId,
					checkoutPath: project.paths.checkoutPath,
					revisionId: project.project().headRevisionId,
					revisions: (await project.history()).map(({ id, parentId }) => ({ id, parentId })),
					entries: await listProjectFiles(project.paths.checkoutPath),
				};
			case "workspace.file.read": {
				const args = input as LocalCommandInput<"workspace.file.read">;
				return args.revisionId === undefined
					? readProjectFile(project.paths.checkoutPath, args.path)
					: revisionFileView(args.path, await project.readRevisionFile(args.revisionId, args.path));
			}
			case "workspace.file.save": {
				const result = await saveProjectFile(
					project.paths.checkoutPath,
					input as LocalCommandInput<"workspace.file.save">,
				);
				this.#changed();
				return result;
			}
			case "workspace.file.open": {
				const args = input as LocalCommandInput<"workspace.file.open">;
				const absolute = await resolveProjectFile(project.paths.checkoutPath, args.path);
				if (!this.#systemFile)
					throw new ArtifactError("system_open_requires_desktop", "请在桌面应用中打开系统文件");
				await this.#systemFile(absolute, args.action);
				return {};
			}
			case "models.show":
				return this.#settings.show();
			case "models.provider.setEnabled": {
				await this.#settings.setProviderEnabled(input as LocalCommandInput<"models.provider.setEnabled">);
				this.#modelsChanged = true;
				this.#changed();
				return {};
			}
			case "models.save": {
				await this.#settings.save(input as LocalCommandInput<"models.save">);
				this.#modelsChanged = true;
				this.#changed();
				return {};
			}
			// 凭据由 Models 在每次调用时从 auth.json 读取，登录与断开不必重建 session controller。
			case "models.login.start":
				return this.#settings.startLogin(input as LocalCommandInput<"models.login.start">);
			case "models.login.status":
				return this.#settings.loginStatus(input as LocalCommandInput<"models.login.status">);
			case "models.login.reply":
				this.#settings.replyLogin(input as LocalCommandInput<"models.login.reply">);
				return {};
			case "models.login.cancel":
				this.#settings.cancelLogin(input as LocalCommandInput<"models.login.cancel">);
				return {};
			case "models.disconnect":
				await this.#settings.disconnect(input as LocalCommandInput<"models.disconnect">);
				return {};
			case "workspace.show": {
				const record = project.project();
				// 已提交版本只要每个文件的摘要：按版本缓存的 blob id，不再每次从 git 把整份版本读出来
				// （斗破有 2.2 MB 的原作材料，那一步每次 35 ms，而这个查询 turn 里每 100ms 刷一次）。
				const [directory, before] = await Promise.all([
					readOpenStoryDirectory(project.paths.checkoutPath, this.#directoryCache),
					project.historyReader().fileDigests(record.headRevisionId),
				]);
				let index: StoryIndexView = { volumes: [], openEnded: false };
				const files = directory.files.map((file) => {
					const projection = this.#projection(file);
					if (projection.index) index = projection.index;
					return { ...projection.file, dirty: before.get(file.path) !== projection.blobId };
				});
				const derived = await this.#textProjectionFor(record.headRevisionId);
				return {
					projectId: record.id,
					checkoutPath: record.checkoutPath,
					revisionId: record.headRevisionId,
					dirty:
						files.some((file) => file.dirty) ||
						[...before.keys()].some((path) => !directory.files.some((current) => current.path === path)),
					files,
					volumes: "error" in index ? [] : index.volumes,
					...("error" in index
						? { storyIndexError: index.error }
						: index.openEnded
							? { openEnded: true as const }
							: {}),
					storyText: derived.storyText,
					...(derived.derivedError === undefined ? {} : { derivedError: derived.derivedError }),
					revisions: (await project.history()).map((revision) => ({
						id: revision.id,
						parentId: revision.parentId,
					})),
				};
			}
			case "project.check":
				// 检查本身抛错时和其它命令一样抛出去：渲染层的 act() 会显示原因，不必在带内多一个字段。
				return checkSummary(await project.check());
			case "project.commit": {
				const result = await project.commitCheckout();
				this.#changed();
				return commitResult(result);
			}
			case "project.rollback": {
				// 与 commit 同一条路，不另设门：Agent 与作者共用一份 checkout，没有三方合并，正在跑的会话下一次扫描就看到回退后的文件。
				const args = input as LocalCommandInput<"project.rollback">;
				const result = await project.rollbackRevision(args.revisionId);
				this.#changed();
				return rollbackResult(result);
			}
			case "project.diff": {
				// 只比摘要：checkout 一侧走目录缓存与投影里记住的 blob id，已提交一侧是按版本缓存的 blob id。
				const [directory, before] = await Promise.all([
					readOpenStoryDirectory(project.paths.checkoutPath, this.#directoryCache),
					project.historyReader().fileDigests(project.project().headRevisionId),
				]);
				return changedFiles(
					before,
					new Map(directory.files.map((file) => [file.path, this.#projection(file).blobId])),
				);
			}
			case "revision.diff": {
				const args = input as LocalCommandInput<"revision.diff">;
				const revision = (await project.history()).find((item) => item.id === args.revisionId);
				if (!revision) throw new ArtifactError("revision_not_found", args.revisionId);
				const reader = project.historyReader();
				const [before, after] = await Promise.all([
					revision.parentId ? reader.fileDigests(revision.parentId) : new Map<string, string>(),
					reader.fileDigests(revision.id),
				]);
				return changedFiles(before, after);
			}
			case "workspace.context": {
				const args = input as LocalCommandInput<"workspace.context">;
				const task = parseHostContextTask(args.task);
				const session = await project.openRuntimeSession(args.revisionId);
				const candidate = session.artifacts.snapshot(session.memoryRevisionId);
				if (task.kind === "design-view") {
					const view = compileDesignViewContext(candidate, task.view);
					return {
						text: view.text,
						revisionId: session.memoryRevisionId,
						paths: view.artifacts.map((artifact) =>
							storyPackageCodec.pathForIdentity(artifact.identity, candidate),
						),
					};
				}
				if (task.kind === "write") {
					const context = compileWriteContext(candidate, task.storyBeatId);
					return {
						text: context.text,
						revisionId: session.memoryRevisionId,
						paths: context.artifacts.map((identity) => storyPackageCodec.pathForIdentity(identity, candidate)),
					};
				}
				// 桌面只用这两种。其余种类原来静默退回一份裁剪过的 Design Frame——内容错了也看不出来。
				throw new ArtifactError(
					"unsupported_context_task",
					`workspace.context compiles only write and design view tasks, not ${args.task}; use suim context compile`,
				);
			}
			case "workspace.reviews": {
				const { candidate, reviews } = await committedReviews(project);
				const designKinds = new Set<string>(TARGET_DESIGN_KINDS);
				const designPaths = new Set(
					candidate.artifacts
						.filter((artifact) => designKinds.has(artifact.identity.kind))
						.map((artifact) => artifact.path),
				);
				const result: LocalCommandOutput<"workspace.reviews"> = [];
				for (const { review, summary } of reviews) {
					const scope = review.file.scope;
					const paths =
						scope.kind === "beats"
							? scope.storyBeatIds.map((id) => `text/${id}.md`)
							: scope.kind === "source"
								? candidate.artifacts
										.filter(
											(artifact) =>
												artifact.identity.namespace.kind === "source" &&
												artifact.identity.namespace.sourceId === scope.sourceId,
										)
										.map((artifact) => artifact.path)
								: review.file.layer === "text"
									? candidate.artifacts
											.filter((artifact) => artifact.identity.kind === "story-text")
											.map((artifact) => artifact.path)
									: [...designPaths];
					result.push({
						...summary,
						paths: paths.sort(),
						findings: review.file.draft.findings.map((finding) => ({
							title: finding.issue,
							evidence: finding.evidence,
							suggestion: finding.suggestion ?? "",
							paths:
								finding.anchor.kind === "artifact"
									? [finding.anchor.path]
									: [`source/${finding.anchor.sourceId}/material.txt`],
						})),
					});
				}
				return result;
			}
			case "session.tasks": {
				const args = input as LocalCommandInput<"session.tasks">;
				const state = project.loadExecutionEntities();
				if (!state.sessions.some((session) => session.id === args.sessionId))
					throw new ArtifactError("session_not_found", args.sessionId);
				return taskSummaries(state, args.sessionId);
			}
			case "session.send": {
				const args = input as LocalCommandInput<"session.send">;
				return this.#once(args.commandId, { command, args }, async () => {
					// 先预检模型与凭据，再建 session：配置问题在创建前就以 profile 名报出，不留下一条空 session。
					const controller = await this.#controller();
					const gateway = this.#modelsChanged ? await this.#models() : this.#gateway;
					const binding =
						args.sessionId === undefined || args.model !== undefined
							? (await gateway?.bind("main", args.model))?.snapshot
							: undefined;
					const result = await controller.send({
						commandId: args.commandId,
						text: args.text,
						...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
						...(args.model === undefined ? {} : { model: args.model }),
						...(binding === undefined ? {} : { binding }),
						onEvent: () => this.#changed("stream"),
					});
					this.#changed();
					void controller
						.completion(result.sessionId)
						.catch(() => undefined)
						.finally(() => this.#changed());
					return result;
				});
			}
			case "session.resume": {
				const args = input as LocalCommandInput<"session.resume">;
				return this.#once(args.commandId, { command, args }, async () => {
					const controller = await this.#controller();
					const gateway = args.model && this.#modelsChanged ? await this.#models() : this.#gateway;
					const binding = args.model ? (await gateway?.bind("main", args.model))?.snapshot : undefined;
					const result = await controller.resume({
						commandId: args.commandId,
						sessionId: args.sessionId,
						retryUnknownModelCall: args.retryUnknown ?? false,
						...(binding === undefined ? {} : { binding }),
						onEvent: () => this.#changed("stream"),
					});
					this.#changed();
					void controller
						.completion(result.sessionId)
						.catch(() => undefined)
						.finally(() => this.#changed());
					return result;
				});
			}
			case "session.interrupt": {
				const args = input as LocalCommandInput<"session.interrupt">;
				const state = project.loadExecutionEntities();
				const session = state.sessions.find((item) => item.id === args.sessionId);
				if (!session) throw new ArtifactError("session_not_found", args.sessionId);
				if (session.status === "paused") {
					const settled = abandonPausedSession(project, session.id);
					this.#changed();
					return { status: settled.status };
				}
				if (this.#sessions?.activeSessionIds().includes(args.sessionId)) {
					this.#sessions.interrupt(args.sessionId, "作者停止了当前回复");
					// 作者在等这条命令返回，界限要短。收不了口时如实回 running，作者可以再点一次。
					await this.#sessions.waitForIdle({ timeoutMs: CANCEL_SETTLE_TIMEOUT_MS });
				}
				this.#changed();
				const settled = project.loadExecutionEntities().sessions.find((item) => item.id === args.sessionId);
				if (!settled) throw new ArtifactError("session_not_found", args.sessionId);
				return { status: settled.status };
			}
			case "session.delete": {
				const args = input as LocalCommandInput<"session.delete">;
				if (this.#sessions?.activeSessionIds().includes(args.sessionId))
					throw new ArtifactError("session_running", "turn 进行中不能删除 session；先停止");
				(await this.#controller()).harness().deleteSession(args.sessionId);
				this.#changed();
				return {};
			}
			case "session.inbox": {
				const { sessionId } = input as LocalCommandInput<"session.inbox">;
				const session = project.loadExecutionEntities().sessions.find((item) => item.id === sessionId);
				if (!session) throw new ArtifactError("session_not_found", sessionId);
				const consumed = session.inboxSequence ?? 0;
				return project.readInbox(sessionId).map((item) => ({ ...item, delivered: item.sequence <= consumed }));
			}
			case "session.attach": {
				const args = input as LocalCommandInput<"session.attach">;
				if (!project.loadExecutionEntities().sessions.some((session) => session.id === args.sessionId))
					throw new ArtifactError("session_not_found", args.sessionId);
				const events = project.readSessionEvents(args.sessionId, args.afterSequence ?? 0);
				return {
					sessionId: args.sessionId,
					cursor: events.at(-1)?.sequence ?? args.afterSequence ?? 0,
					events: args.afterSequence === undefined ? [] : events,
					...(args.afterSequence === undefined ? { snapshot: productEventSnapshot(events) } : {}),
				};
			}
		}
	}
	/** 运行投影独立于作品扫描，正文流式更新不读取整个 checkout。标题是 inbox 的第一条消息。 */
	#sessionList(): LocalCommandOutput<"session.list">["sessions"] {
		return sessionSummaries(this.project.loadExecutionEntities(), (id) => this.project.firstInboxText(id));
	}
	/** 正文时效从 Canon 历史派生，只随 head 变化；show 每 100ms 刷一次，同一 head 只算一遍。 */
	#textProjectionFor(revisionId: string): Promise<TextProjection> {
		if (this.#textProjection?.revisionId === revisionId) return this.#textProjection.value;
		const value = (async (): Promise<TextProjection> => {
			try {
				const reader = this.project.historyReader();
				return { storyText: await textCurrencies(reader, revisionId, await reader.snapshot(revisionId)) };
			} catch (error) {
				// 派生坏了不该让目录列表也消失；标出原因，让 Checker / 命令行给准确诊断。
				return { storyText: [], derivedError: error instanceof Error ? error.message : String(error) };
			}
		})();
		this.#textProjection = { revisionId, value };
		return value;
	}
	#once<T>(id: string, input: unknown, body: () => Promise<T>): Promise<T> {
		const fingerprint = hash(canonicalJson(input));
		const previous = this.#pending.get(id);
		if (previous) {
			if (previous.fingerprint !== fingerprint)
				return Promise.reject(new ArtifactError("command_conflict", "同一命令不能改变输入"));
			return previous.result as Promise<T>;
		}
		const result = body();
		this.#pending.set(id, { fingerprint, result });
		void result.finally(() => this.#pending.delete(id)).catch(() => undefined);
		return result;
	}
}
