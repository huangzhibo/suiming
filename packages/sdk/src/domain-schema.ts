import { type Static, Type } from "typebox";

/**
 * 领域对象的共用 schema。
 *
 * 三套命令目录（CLI / 桌面 IPC / Cloud HTTP）曾各自定义同一批对象，`run.list` 因此在 CLI 与 IPC 下
 * 有两份不兼容的形状，同名却不同字段。这里是这些对象的唯一定义，三个传输都从这里取；传输之间的差异
 * 只能是命名与信封，不能是内容。
 */
const id = Type.String({ minLength: 1 });

export const sessionStatusSchema = Type.Union([Type.Literal("idle"), Type.Literal("running"), Type.Literal("paused")]);
export const sessionKindSchema = Type.Union([Type.Literal("agent"), Type.Literal("rank")]);

export const executionFailureSchema = Type.Object(
	{ code: id, message: id, retryable: Type.Boolean() },
	{ additionalProperties: false },
);

export const resultReferenceSchema = Type.Object({ kind: Type.Literal("object"), id }, { additionalProperties: false });

const nonnegative = Type.Number({ minimum: 0 });

export const modelUsageSchema = Type.Object(
	{
		calls: Type.Integer({ minimum: 0 }),
		confirmedCalls: Type.Optional(Type.Integer({ minimum: 0 })),
		input: nonnegative,
		output: nonnegative,
		cacheRead: nonnegative,
		cacheWrite: nonnegative,
		reasoning: nonnegative,
		totalTokens: nonnegative,
		costUsd: nonnegative,
	},
	{ additionalProperties: false },
);

export const thinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
export const modelThinkingSchema = Type.Union([thinkingLevelSchema, Type.Literal("default")]);
export const modelChoiceSchema = Type.Object(
	{ provider: id, model: id, thinking: Type.Optional(modelThinkingSchema) },
	{ additionalProperties: false },
);
export type ModelChoice = Static<typeof modelChoiceSchema>;

export const reviewLayerSchema = Type.Union([Type.Literal("design"), Type.Literal("source"), Type.Literal("text")]);

export const reviewScopeSchema = Type.Union([
	Type.Object({ kind: Type.Literal("book") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("beats"), storyBeatIds: Type.Array(id) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("source"), sourceId: id }, { additionalProperties: false }),
]);

export const reviewVerdictSchema = Type.Union([
	Type.Literal("pass"),
	Type.Literal("revise"),
	Type.Literal("block"),
	Type.Literal("insufficient_context"),
]);

/**
 * 一份审稿文件（`review/<id>.md`）的摘要与它对当前稿还算不算数，与 `committedReviews()` 投影成对。
 * CLI 的 review list / show 与桌面的 workspace.reviews 共用；桌面在上面多带 paths 与 findings。
 */
export const reviewSummarySchema = Type.Object(
	{
		id,
		path: id,
		layer: reviewLayerSchema,
		scope: reviewScopeSchema,
		/** 审稿看的版本（标签；时效不按它判）。 */
		revision: id,
		/** 审稿记下的主体摘要与当前候选一致；审稿之后才成为主体的文件也让它过时。 */
		current: Type.Boolean(),
		changed: Type.Array(id),
		verdict: reviewVerdictSchema,
		summary: id,
		findingCount: Type.Integer({ minimum: 0 }),
		uncoveredCount: Type.Integer({ minimum: 0 }),
		uncertaintyCount: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

/** 模型 profile 的 id：配置、设置页与执行记录共用。 */
export const modelProfileIdSchema = Type.Union([
	Type.Literal("main"),
	Type.Literal("reviewer"),
	Type.Literal("writer"),
	Type.Literal("source-reader"),
	Type.Literal("source-extractor"),
	Type.Literal("judge"),
]);

/** 一次执行实际绑定的模型（来自哪个 profile、哪种凭据）；只读记录，不是选择。 */
export const modelBindingSchema = Type.Object(
	{
		profileId: modelProfileIdSchema,
		provider: id,
		model: id,
		routingVersion: id,
		credentialType: id,
	},
	{ additionalProperties: false },
);

/**
 * 子任务摘要的唯一 schema，与 `taskSummaries()` 投影成对。桌面的 `session.tasks` 与 CLI 的
 * `session show` 共用；2026-10-02 之前两边各投影一份，字段名都不一样。
 */
export const taskSummarySchema = Type.Object(
	{
		id,
		/** 子任务的角色，即它绑定的模型档位（writer、reviewer、judge……）；2026-10-05 之前的记录是 subagent / review / rank.round。 */
		kind: id,
		key: id,
		/** 给作者看的一句话；2026-10-06 之前的记录没有。 */
		title: Type.Optional(Type.String({ minLength: 1 })),
		status: id,
		parentTaskId: Type.Optional(id),
		model: Type.Optional(modelBindingSchema),
		result: Type.Optional(resultReferenceSchema),
		failure: Type.Optional(executionFailureSchema),
	},
	{ additionalProperties: false },
);

/**
 * Session 摘要的唯一 schema，与 `sessionSummary()` 投影成对。`title` 是 inbox 的第一条消息，
 * 由调用方取；`pause` 是要作者处理的原因（三种），`lastFailure` 是作者一句话就能续的那类。
 */
export const sessionSummarySchema = Type.Object(
	{
		id,
		title: Type.String(),
		kind: sessionKindSchema,
		status: sessionStatusSchema,
		turn: Type.Integer({ minimum: 0 }),
		turnId: Type.Optional(id),
		usage: Type.Optional(modelUsageSchema),
		model: Type.Optional(modelChoiceSchema),
		pause: Type.Optional(executionFailureSchema),
		lastFailure: Type.Optional(executionFailureSchema),
		result: Type.Optional(resultReferenceSchema),
		createdAt: id,
		updatedAt: id,
	},
	{ additionalProperties: false },
);

/**
 * 一个 ProjectRevision 的摘要。CLI 与桌面共用；桌面此前只回一个 `revisionId`。
 *
 * 曾经还有 `artifactCount`，但只有 `suim history` 显示它，而为了数一个数字，git store 必须把
 * 每个历史版本的整棵 tree 连字节读出来——那正是 `history()` 的 234 ms。版本里有几个文件要看
 * 快照，不从版本身份里拿。
 */
export const revisionSummarySchema = Type.Object(
	{ id, parentId: Type.Union([id, Type.Null()]) },
	{ additionalProperties: false },
);

/** commit 与 rollback 的共同结果：`created` 为 false 表示内容与当前版本相同，没有新建版本。 */
export const commitResultSchema = Type.Object(
	{ created: Type.Boolean(), revision: revisionSummarySchema },
	{ additionalProperties: false },
);

/**
 * Checker 结果，与 `checkSummary()` 投影成对。`passed` 表示没有阻塞提交的问题——`missing_text`
 * 只说明全书还没写完，不让它变 false；要判断全书正文是否齐了看 `storyTextPassed`。
 */
/** 一条确定性诊断：message 是拼好的整句，path 供按文件归类。check 结果与失败信封共用。 */
export const checkDiagnosticSchema = Type.Object(
	{
		severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
		path: Type.Optional(id),
		line: Type.Optional(Type.Integer()),
		column: Type.Optional(Type.Integer()),
		pointer: Type.Optional(Type.String()),
		detail: Type.String(),
		message: id,
	},
	{ additionalProperties: false },
);

export const checkSummarySchema = Type.Object(
	{
		passed: Type.Boolean(),
		changedFiles: Type.Integer({ minimum: 0 }),
		designPassed: Type.Boolean(),
		statePassed: Type.Boolean(),
		storyTextPassed: Type.Boolean(),
		storyTextFailures: Type.Array(
			Type.Object({ storyBeatId: id, code: id, message: id }, { additionalProperties: false }),
		),
		sourceCount: Type.Integer({ minimum: 0 }),
		diagnostics: Type.Array(checkDiagnosticSchema),
	},
	{ additionalProperties: false },
);

const revisionFileSide = Type.Object(
	{ mediaType: id, contentSha256: id, byteLength: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: false },
);

/**
 * rollback 比 commit 多说三件事：恢复到哪个版本、原来的 head 是谁、这次改了哪些文件。
 * 桌面此前只拿到 `created`，现在与 CLI 同一份——恢复历史版本是作者要能复核的动作。
 */
export const rollbackResultSchema = Type.Object(
	{
		created: Type.Boolean(),
		targetRevisionId: id,
		previousHeadRevisionId: id,
		revision: revisionSummarySchema,
		changes: Type.Array(
			Type.Object(
				{
					kind: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
					path: id,
					before: Type.Optional(revisionFileSide),
					after: Type.Optional(revisionFileSide),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
