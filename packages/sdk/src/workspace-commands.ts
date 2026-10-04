import { type Static, type TSchema, type TUnsafe, Type } from "typebox";
import {
	type checkDiagnosticSchema,
	checkSummarySchema,
	commitResultSchema,
	type ModelChoice,
	modelChoiceSchema,
	modelProfileIdSchema,
	modelThinkingSchema,
	reviewSummarySchema,
	rollbackResultSchema,
	sessionSummarySchema,
	taskSummarySchema,
	thinkingLevelSchema,
} from "./domain-schema.js";
import { ProductEventSchema, type SessionEvent, type SessionEventBody, SessionEventSchema } from "./run-event.js";
import { USAGE_CHECKPOINT_TOKENS } from "./usage-checkpoint.js";

const id = Type.String({ minLength: 1 });

export { type ModelChoice, modelChoiceSchema, modelThinkingSchema, thinkingLevelSchema };

const empty = Type.Object({}, { additionalProperties: false });
const file = Type.Object(
	{ path: id, content: Type.String(), sha256: Type.Union([Type.String(), Type.Null()]) },
	{ additionalProperties: false },
);
const session = sessionSummarySchema;
const revision = Type.Object({ id, parentId: Type.Union([id, Type.Null()]) }, { additionalProperties: false });
/**
 * 两侧有差别的作品文件清单，project.diff 与 revision.diff 共用。只有路径与增删改：比较页选中哪个文件，
 * 再用 workspace.file.read（带或不带 revisionId）读那一个的两侧。2026-10-02 之前这里带全部改动文件的正文，
 * 而界面一次只渲染一个，比较页开着时每次刷新都把整个已提交版本导出、解码一遍。
 */
const fileDiff = Type.Array(
	Type.Object(
		{ path: id, kind: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]) },
		{ additionalProperties: false },
	),
);
/** 正文时效（Runtime `TextCurrency`）：current / design-changed / uncommitted / missing。 */
const textCurrency = Type.Object(
	{
		storyBeatId: id,
		state: Type.Union([
			Type.Literal("current"),
			Type.Literal("design-changed"),
			Type.Literal("uncommitted"),
			Type.Literal("missing"),
		]),
		/** 正文最后一次变化所在的版本；未提交时不设。 */
		writtenAt: Type.Optional(id),
		/** 写成之后变过的 Design 闭包路径。 */
		changed: Type.Array(id),
	},
	{ additionalProperties: false },
);
/** 一个作品文件的目录投影。frontmatter 原样透传，字段语义由 Story Language 决定，这里不复制字段表。 */
const fileEntry = Type.Object(
	{
		path: id,
		kind: id,
		localId: id,
		namespace: Type.String(),
		codePoints: Type.Integer(),
		dirty: Type.Boolean(),
		title: Type.Optional(Type.String()),
		/** 正文的第一个一级标题：Contract、世界设定这类没有 title / name 字段的文件靠它显示中文名。 */
		heading: Type.Optional(Type.String()),
		frontmatter: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: false },
);
const volume = Type.Object({ id, title: Type.String(), beatIds: Type.Array(id) }, { additionalProperties: false });
function command<I extends TSchema, O extends TSchema>(input: I, output: O) {
	return { input, output };
}

export interface SessionAttachResult {
	sessionId: string;
	cursor: number;
	events: SessionEvent[];
	snapshot?: SessionEventBody[];
}
const attachResult: TUnsafe<SessionAttachResult> = Type.Unsafe<SessionAttachResult>(
	Type.Object(
		{
			sessionId: id,
			cursor: Type.Integer({ minimum: 0 }),
			events: Type.Array(SessionEventSchema),
			snapshot: Type.Optional(Type.Array(ProductEventSchema)),
		},
		{ additionalProperties: false },
	),
);

/** 本地应用命令目录：查询是领域投影，执行交给同一个 Runtime；IPC 不定义自己的参数或结果。 */
export const LOCAL_COMMANDS = {
	"session.list": command(
		empty,
		Type.Object({ projectId: id, sessions: Type.Array(session) }, { additionalProperties: false }),
	),
	/** 原始目录独立于作品投影；无效作品文件不能挡住作者修复入口。 */
	"workspace.files": command(
		empty,
		Type.Object(
			{
				projectId: id,
				checkoutPath: id,
				revisionId: id,
				revisions: Type.Array(revision),
				entries: Type.Array(
					Type.Object(
						{
							path: id,
							type: Type.Union([Type.Literal("directory"), Type.Literal("file"), Type.Literal("symlink")]),
							size: Type.Integer({ minimum: 0 }),
							classification: Type.Union([
								Type.Literal("story"),
								Type.Literal("auxiliary"),
								Type.Literal("invalid"),
							]),
							diagnostic: Type.Optional(Type.String()),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
	),
	/**
	 * 读作品目录里的一个文件；带 revisionId 读那个已提交版本里的（只读那一个 blob，不可写）。还没写的
	 * 作品文件（如未写正文的 text/<beat>.md）回空内容、sha256 为 null，保存时新建；其它不存在的文件报错。
	 * 2026-10-02 之前另有只管作品文件的 workspace.read / save，与这一组大面积重叠，已删。
	 */
	"workspace.file.read": command(
		Type.Object({ path: id, revisionId: Type.Optional(id) }, { additionalProperties: false }),
		Type.Object(
			{
				path: id,
				content: Type.String(),
				sha256: Type.Union([Type.String(), Type.Null()]),
				size: Type.Integer({ minimum: 0 }),
				textual: Type.Boolean(),
				writable: Type.Boolean(),
				classification: Type.String(),
				diagnostic: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
	),
	"workspace.file.save": command(
		Type.Object(
			{ path: id, content: Type.String(), expectedSHA: Type.Union([Type.String(), Type.Null()]) },
			{ additionalProperties: false },
		),
		file,
	),
	"workspace.file.open": command(
		Type.Object(
			{ path: id, action: Type.Union([Type.Literal("reveal"), Type.Literal("open")]) },
			{ additionalProperties: false },
		),
		empty,
	),
	"models.show": command(
		empty,
		Type.Object({
			profiles: Type.Array(
				Type.Object({
					id: modelProfileIdSchema,
					/** 面向作者的名称与用途，来自 runtime 的 MODEL_PROFILE_LABELS；报错里点的也是这个名字。 */
					label: Type.String(),
					description: Type.String(),
					provider: Type.String(),
					model: Type.String(),
					options: Type.String(),
					thinking: Type.Optional(modelThinkingSchema),
					source: Type.String(),
					/** ready：模型存在且 provider 有可用凭据；其余是作者要处理的原因，detail 是可直接展示的说明。 */
					state: Type.Union([
						Type.Literal("ready"),
						Type.Literal("missing_credentials"),
						Type.Literal("provider_disabled"),
						Type.Literal("unknown_model"),
						Type.Literal("unconfigured"),
					]),
					detail: Type.String(),
				}),
			),
			providers: Type.Array(
				Type.Object({
					id,
					name: id,
					/** API key 认证：name 是 provider 给的名称；login 为 false 表示只认环境凭据（AWS profile 等），没有输入入口。 */
					apiKey: Type.Union([Type.Object({ name: Type.String(), login: Type.Boolean() }), Type.Null()]),
					/** OAuth 认证；subscription 是服务商提供的订阅标记，不作为调用权限判断。 */
					oauth: Type.Union([Type.Object({ name: Type.String(), subscription: Type.Boolean() }), Type.Null()]),
					enabled: Type.Boolean(),
					/** 本地凭据文件里保存的类型。 */
					stored: Type.Union([Type.Literal("api_key"), Type.Literal("oauth"), Type.Literal("none")]),
					/** provider 是否能解析凭据（不等于请求验证成功），以及凭据来源（环境变量名、stored credential、OAuth）。 */
					usable: Type.Union([Type.Object({ type: id, source: Type.String() }), Type.Null()]),
					models: Type.Array(Type.Object({ id, name: id, thinkingLevels: Type.Array(thinkingLevelSchema) })),
				}),
			),
			usageCheckpoint: Type.Object({
				tokens: Type.Integer(),
				/** 默认模型的目录输入单价（美元 / 百万 token），设置页据此换算「约合多少钱」；目录里没有时为 null。 */
				mainInputPrice: Type.Union([Type.Number(), Type.Null()]),
			}),
		}),
	),
	"models.usageCheckpoint.save": command(
		Type.Object(
			{
				tokens: Type.Integer({ minimum: USAGE_CHECKPOINT_TOKENS.min, maximum: USAGE_CHECKPOINT_TOKENS.max }),
			},
			{ additionalProperties: false },
		),
		empty,
	),
	"models.provider.setEnabled": command(
		Type.Object({ provider: id, enabled: Type.Boolean() }, { additionalProperties: false }),
		empty,
	),
	"models.save": command(
		Type.Object(
			{
				profile: modelProfileIdSchema,
				provider: id,
				model: id,
				options: Type.Optional(Type.String()),
				thinking: Type.Optional(modelThinkingSchema),
			},
			{ additionalProperties: false },
		),
		empty,
	),
	/** 登录是 provider 自己的交互流程（输入 key、浏览器授权、设备码），主进程执行，窗口只转述提示与回答。 */
	"models.login.start": command(
		Type.Object(
			{ provider: id, type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]) },
			{ additionalProperties: false },
		),
		Type.Object({ sessionId: id }, { additionalProperties: false }),
	),
	"models.login.status": command(
		Type.Object({ sessionId: id }, { additionalProperties: false }),
		Type.Object(
			{
				sessionId: id,
				provider: id,
				status: Type.Union([
					Type.Literal("pending"),
					Type.Literal("succeeded"),
					Type.Literal("failed"),
					Type.Literal("cancelled"),
				]),
				events: Type.Array(
					Type.Union([
						Type.Object({ type: Type.Literal("info"), message: Type.String() }, { additionalProperties: false }),
						Type.Object(
							{ type: Type.Literal("progress"), message: Type.String() },
							{ additionalProperties: false },
						),
						Type.Object(
							{ type: Type.Literal("auth_url"), url: Type.String(), instructions: Type.Optional(Type.String()) },
							{ additionalProperties: false },
						),
						Type.Object(
							{
								type: Type.Literal("device_code"),
								userCode: Type.String(),
								verificationUri: Type.String(),
								expiresInSeconds: Type.Optional(Type.Integer()),
							},
							{ additionalProperties: false },
						),
					]),
				),
				prompt: Type.Optional(
					Type.Object(
						{
							id,
							type: Type.Union([
								Type.Literal("text"),
								Type.Literal("secret"),
								Type.Literal("select"),
								Type.Literal("manual_code"),
							]),
							message: Type.String(),
							placeholder: Type.Optional(Type.String()),
							options: Type.Optional(
								Type.Array(
									Type.Object(
										{ id, label: Type.String(), description: Type.Optional(Type.String()) },
										{ additionalProperties: false },
									),
								),
							),
						},
						{ additionalProperties: false },
					),
				),
				error: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
	),
	"models.login.reply": command(
		Type.Object({ sessionId: id, promptId: id, value: Type.String() }, { additionalProperties: false }),
		empty,
	),
	"models.login.cancel": command(Type.Object({ sessionId: id }, { additionalProperties: false }), empty),
	/** 删除本地保存的凭据；环境变量提供的凭据不受影响。 */
	"models.disconnect": command(Type.Object({ provider: id }, { additionalProperties: false }), empty),

	"workspace.show": command(
		empty,
		Type.Object(
			{
				projectId: id,
				checkoutPath: id,
				revisionId: id,
				dirty: Type.Boolean(),
				files: Type.Array(fileEntry),
				/** index.yaml 声明的卷与 Beat 顺序；index 缺失或无法解析时为空。 */
				volumes: Type.Array(volume),
				/** 作者在 index 声明全书未完待续（`open_ended: true`）：`book_end` 的 Contract 不算到期。 */
				openEnded: Type.Optional(Type.Literal(true)),
				/** index.yaml 存在但无法解码或解析时的原因；缺失时不设。Checker 在检查 / 提交时给准确诊断。 */
				storyIndexError: Type.Optional(Type.String()),
				/** 每个 Beat 正文相对 Design 的时效，从 Canon 历史派生：写成之后它的 Design 闭包有没有变。 */
				storyText: Type.Array(textCurrency),
				/** 派生失败时的原因；此时 storyText 为空，目录列表照常。 */
				derivedError: Type.Optional(Type.String()),
				/** 对话列表不在这里：它只有 `session.list` 一份，两边各算一遍时每次刷新都白算一次。 */
				revisions: Type.Array(revision),
			},
			{ additionalProperties: false },
		),
	),
	/**
	 * 结构化结果，文案归界面。此前 runtime 在这里拼一句中文返给渲染层，作者看不出是哪一项没过。
	 * 与 CLI 的 `project.check` 是同一份 payload；检查本身抛错（作品文件坏到没法检查）走和其它命令
	 * 一样的错误路径，不在带内多一个字段。
	 */
	"project.check": command(empty, checkSummarySchema),
	"project.commit": command(empty, commitResultSchema),
	"project.rollback": command(Type.Object({ revisionId: id }, { additionalProperties: false }), rollbackResultSchema),
	/**
	 * checkout 对 head。曾经这一个名字承担三件事，靠「你传了哪个可选参数」区分语义，契约不可读；
	 * 现在按被比较的对象分成两条：`project.diff`（checkout 对 head）与 `revision.diff`（版本对父版本）。
	 * 没有第三条「某个 session 的候选」——Agent 直接在 checkout 上工作，作者与它只有一份候选。
	 */
	"project.diff": command(empty, fileDiff),
	/** 一个已提交版本对它的父版本；没有父版本时 before 为空。 */
	"revision.diff": command(Type.Object({ revisionId: id }, { additionalProperties: false }), fileDiff),
	"workspace.context": command(
		Type.Object({ task: id, revisionId: Type.Optional(id) }, { additionalProperties: false }),
		Type.Object({ text: Type.String(), paths: Type.Array(id), revisionId: id }, { additionalProperties: false }),
	),
	/** 当前 head 里的全部审稿文件（`review/<id>.md`）与它们相对 head 的时效。 */
	"workspace.reviews": command(
		empty,
		Type.Array(
			Type.Object(
				{
					...reviewSummarySchema.properties,
					/** 审稿挂回哪些页面：beats 范围是那几篇正文，source 是该 Source 的文件，全书正文审稿是全部正文，设计审稿是全套 Design。 */
					paths: Type.Array(id),
					findings: Type.Array(
						Type.Object(
							{
								title: Type.String(),
								/** Reviewer 引用的原文或依据；窗口用其中的引文把 finding 对回段落。 */
								evidence: Type.String(),
								suggestion: Type.String(),
								paths: Type.Array(id),
							},
							{ additionalProperties: false },
						),
					),
				},
				{ additionalProperties: false },
			),
		),
	),
	"session.tasks": command(
		Type.Object({ sessionId: id }, { additionalProperties: false }),
		Type.Array(taskSummarySchema),
	),
	/**
	 * 作者说一句话。没有 sessionId 就新建 session；idle 则开一个 turn，running 则排进 inbox 在下一边界注入；
	 * paused 拒绝并带原因。`model` 只在 turn 边界生效。
	 */
	"session.send": command(
		Type.Object(
			{ commandId: id, text: id, sessionId: Type.Optional(id), model: Type.Optional(modelChoiceSchema) },
			{ additionalProperties: false },
		),
		Type.Object({ sessionId: id, sequence: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
	),
	/** 从 paused 继续：作者已核对原因；retryUnknown 显式授权重发结果未知的模型请求。 */
	"session.resume": command(
		Type.Object(
			{
				commandId: id,
				sessionId: id,
				retryUnknown: Type.Optional(Type.Boolean()),
				model: Type.Optional(modelChoiceSchema),
			},
			{ additionalProperties: false },
		),
		Type.Object({ sessionId: id }, { additionalProperties: false }),
	),
	/** 中止当前 turn：消息列表原样，回 idle。paused 上也可用。 */
	"session.interrupt": command(
		Type.Object({ sessionId: id }, { additionalProperties: false }),
		Type.Object({ status: id }, { additionalProperties: false }),
	),
	"session.delete": command(Type.Object({ sessionId: id }, { additionalProperties: false }), empty),
	/** inbox 里作者已发、模型尚未收到的消息。 */
	"session.inbox": command(
		Type.Object({ sessionId: id }, { additionalProperties: false }),
		Type.Array(
			Type.Object(
				{ sequence: Type.Integer({ minimum: 1 }), text: Type.String(), delivered: Type.Boolean() },
				{ additionalProperties: false },
			),
		),
	),
	"session.attach": command(
		Type.Object(
			{ sessionId: id, afterSequence: Type.Optional(Type.Integer({ minimum: 0 })) },
			{ additionalProperties: false },
		),
		attachResult,
	),
} as const;
export type LocalCommandName = keyof typeof LOCAL_COMMANDS;
export type LocalCommandInput<K extends LocalCommandName> = Static<(typeof LOCAL_COMMANDS)[K]["input"]>;
export type LocalCommandOutput<K extends LocalCommandName> = Static<(typeof LOCAL_COMMANDS)[K]["output"]>;
export interface LocalCommandClient {
	invoke<K extends LocalCommandName>(command: K, input: LocalCommandInput<K>): Promise<LocalCommandOutput<K>>;
}
/** 查询失效提示，不承载状态；完整运行记录仍通过命令与持久 AG-UI attach 读取。 */
export type WorkspaceChange = "workspace" | "execution" | "stream";
/**
 * 命令失败时 `DesktopBridge.invoke` 拒绝的值。是普通对象而不是 Error：contextBridge 复制 Error 时只留
 * message 与 stack，自定义属性全丢（Electron 42 实测 `code` 与 `diagnostics` 都过不来）。renderer 的
 * invoke 再把它还原成 Error。`diagnostics` 是绑定期失败（作品还不能绑定成设计）带出的全部问题，与
 * CLI 失败信封的 `error.diagnostics` 同一份。
 */
export interface DesktopCommandFailure {
	code: string;
	message: string;
	diagnostics?: Static<typeof checkDiagnosticSchema>[];
}
export interface DesktopBridge extends LocalCommandClient {
	/** 通过系统保存对话框导出文字副本，不写入作品 Artifact。 */
	exportConversation(content: string): Promise<boolean>;
	chooseProject(create: boolean): Promise<boolean>;
	/** 最近打开过且目录仍存在的作品，最新在前。 */
	recentProjects(): Promise<{ path: string; name: string }[]>;
	openProject(path: string): Promise<boolean>;
	onChange(listener: (changes: WorkspaceChange[]) => void): () => void;
}
