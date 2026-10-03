import { type Static, type TSchema, Type } from "typebox";
import {
	checkDiagnosticSchema,
	checkSummarySchema,
	commitResultSchema,
	reviewLayerSchema,
	reviewSummarySchema,
	reviewVerdictSchema,
	revisionSummarySchema,
	rollbackResultSchema,
	sessionSummarySchema,
	taskSummarySchema,
} from "./domain-schema.js";
import { type SessionEvent, SessionEventSchema } from "./run-event.js";

export const SUIM_CLI_PROTOCOL_VERSION = "suim.cli.v1" as const;

export const SUIM_CLI_COMMANDS = [
	"project.init",
	"project.open",
	"project.status",
	"project.diff",
	"project.check",
	"project.commit",
	"project.history",
	"project.rollback",
	"project.export",
	"project.update",
	"read.search",
	"context.compile",
	"text.check",
	"design.impact",
	"design.guide",
	"source.ingest",
	"source.list",
	"review.list",
	"review.show",
	"review.record",
	"review.schema",
	"release.status",
	"release.publish",
	"session.send",
	"session.resume",
	"session.interrupt",
	"session.list",
	"session.show",
	"session.events",
	"rank",
	"cloud.checkout",
	"cloud.import",
	"cloud.link",
	"cloud.status",
	"cloud.push",
	"cloud.pull",
	"cloud.unlink",
] as const;

export type SuimCliCommand = (typeof SUIM_CLI_COMMANDS)[number];

const commandLiterals = Type.Union(SUIM_CLI_COMMANDS.map((command) => Type.Literal(command)));
const namespaceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("target") }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("source"), sourceId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);
const identitySchema = Type.Object(
	{
		namespace: namespaceSchema,
		kind: Type.String({ minLength: 1 }),
		localId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
const diffSideSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		mediaType: Type.String({ minLength: 1 }),
		contentSha256: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
		byteLength: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const diffEntrySchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
		identity: identitySchema,
		before: Type.Optional(diffSideSchema),
		after: Type.Optional(diffSideSchema),
	},
	{ additionalProperties: false },
);
const ignoredEntrySchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		kind: Type.Union([
			Type.Literal("private"),
			Type.Literal("temporary"),
			Type.Literal("repository-auxiliary"),
			Type.Literal("unrecognized"),
		]),
	},
	{ additionalProperties: false },
);

export const SuimCliProjectDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		checkoutPath: Type.String({ minLength: 1 }),
		headRevisionId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const SuimCliProjectInitDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		checkoutPath: Type.String({ minLength: 1 }),
		headRevisionId: Type.String({ minLength: 1 }),
		/** init 写入的仓库文件（脚手架 Design、Intent、host adapter），相对作品目录。 */
		written: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const hostUpdateSchema = Type.Object(
	{
		host: Type.Union([Type.Literal("codex"), Type.Literal("claude-code"), Type.Literal("grok")]),
		skillVersion: Type.String({ minLength: 1 }),
		written: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const SuimCliProjectUpdateDataSchema = Type.Object(
	{ projectId: Type.String({ minLength: 1 }), hosts: Type.Array(hostUpdateSchema, { minItems: 1 }) },
	{ additionalProperties: false },
);

export const SuimCliDiffDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		baseRevisionId: Type.String({ minLength: 1 }),
		state: Type.Union([Type.Literal("clean"), Type.Literal("dirty")]),
		entries: Type.Array(diffEntrySchema),
		ignored: Type.Array(ignoredEntrySchema),
	},
	{ additionalProperties: false },
);

const staleIdsSchema = Type.Object(
	{ count: Type.Integer({ minimum: 0 }), ids: Type.Array(Type.String({ minLength: 1 }), { maxItems: 30 }) },
	{ additionalProperties: false },
);

const storyCountsSchema = Type.Object(
	{
		storyBeats: Type.Integer({ minimum: 0 }),
		storyTexts: Type.Integer({ minimum: 0 }),
		unwrittenBeats: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

/**
 * `project.status` 的摘要。曾经它与 `project.diff` 是同一条命令的两个名字——同一行实现、同一个
 * schema、输出逐字相同，SKILL 却教 host「先 status 再 diff」，第二条拿不到任何新信息。现在
 * status 回答「在哪、有没有改、改了多少」，diff 回答「改了哪些文件」。
 *
 * 形状与 Agent 的 `status` 工具完全一致——`readProjectStatus` 是唯一投影。
 */
export const SuimCliProjectStatusDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		headRevisionId: Type.String({ minLength: 1 }),
		headRevisionLabel: Type.String({ minLength: 1 }),
		committedRevisionCount: Type.Integer({ minimum: 0 }),
		state: Type.Union([Type.Literal("clean"), Type.Literal("dirty")]),
		committed: storyCountsSchema,
		candidate: Type.Object(
			{
				baseRevisionId: Type.String({ minLength: 1 }),
				uncommittedChanges: Type.Integer({ minimum: 0 }),
				...storyCountsSchema.properties,
			},
			{ additionalProperties: false },
		),
		/** 过时的正文（写成之后 Design 闭包改过，Beat id）与审稿（主体已变，审稿 id）；ids 最多 30 个，count 是全数。 */
		stale: Type.Object(
			{
				texts: staleIdsSchema,
				reviews: staleIdsSchema,
				/** 作品读不出来时派生不了时效，写原因；不让整份状态失败。 */
				error: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const revisionSchema = revisionSummarySchema;

/** 与桌面 `project.check` 是同一份 payload——同名命令不允许两种形状。 */
export const SuimCliCheckDataSchema = checkSummarySchema;

/**
 * 与桌面 `project.commit` 是同一份 payload。CLI 侧曾多带一个 `diff`——那是 status 与 diff 还没
 * 分开时的便利；提交后要看改了什么，另取 `revision diff`。
 */
export const SuimCliCommitDataSchema = commitResultSchema;

export const SuimCliHistoryDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		headRevisionId: Type.String({ minLength: 1 }),
		revisions: Type.Array(revisionSchema),
	},
	{ additionalProperties: false },
);

const cloudBindingSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		endpoint: Type.String({ minLength: 1 }),
		cloudProjectId: Type.String({ minLength: 1 }),
		lastSyncedCloudRevisionId: Type.String({ minLength: 1 }),
		lastSyncedLocalRevisionId: Type.String({ minLength: 1 }),
		lastSyncedContentFingerprint: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
		updatedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const cloudSyncFileStateSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		mediaType: Type.String({ minLength: 1 }),
		contentSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		byteLength: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const cloudSyncDeltaSchema = Type.Object(
	{
		key: Type.String({ minLength: 1 }),
		kind: Type.Literal("story"),
		change: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted")]),
		before: Type.Optional(cloudSyncFileStateSchema),
		after: Type.Optional(cloudSyncFileStateSchema),
	},
	{ additionalProperties: false },
);

const cloudSyncConflictSchema = Type.Object(
	{
		key: Type.String({ minLength: 1 }),
		kind: Type.Literal("story"),
		description: Type.String({ minLength: 1 }),
		base: Type.Optional(cloudSyncFileStateSchema),
		local: Type.Optional(cloudSyncFileStateSchema),
		cloud: Type.Optional(cloudSyncFileStateSchema),
	},
	{ additionalProperties: false },
);

export const SuimCliCloudStatusDataSchema = Type.Object(
	{
		state: Type.Union([
			Type.Literal("in_sync"),
			Type.Literal("local_ahead"),
			Type.Literal("cloud_ahead"),
			Type.Literal("diverged_mergeable"),
			Type.Literal("conflict"),
		]),
		dirtyCheckout: Type.Boolean(),
		binding: cloudBindingSchema,
		localHeadRevisionId: Type.String({ minLength: 1 }),
		cloudHeadRevisionId: Type.String({ minLength: 1 }),
		localChanges: Type.Array(cloudSyncDeltaSchema),
		cloudChanges: Type.Array(cloudSyncDeltaSchema),
		conflicts: Type.Array(cloudSyncConflictSchema),
	},
	{ additionalProperties: false },
);

export const SuimCliCloudCheckoutDataSchema = Type.Object(
	{
		project: SuimCliProjectDataSchema,
		binding: cloudBindingSchema,
		cloudRevision: revisionSchema,
	},
	{ additionalProperties: false },
);

export const SuimCliCloudImportDataSchema = Type.Object(
	{ binding: cloudBindingSchema, revision: revisionSchema },
	{ additionalProperties: false },
);

export const SuimCliCloudBindingDataSchema = Type.Object(
	{ binding: cloudBindingSchema },
	{ additionalProperties: false },
);

export const SuimCliCloudSyncDataSchema = Type.Object(
	{
		before: SuimCliCloudStatusDataSchema,
		after: SuimCliCloudStatusDataSchema,
		localRevisionCreated: Type.Boolean(),
		cloudRevisionCreated: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const SuimCliRollbackDataSchema = rollbackResultSchema;

export const SuimCliExportDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revisionId: Type.String({ minLength: 1 }),
		outputPath: Type.String({ minLength: 1 }),
		fileCount: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

export const SuimCliSearchDataSchema = Type.Object(
	{
		basis: Type.Object(
			{
				kind: Type.Literal("project_revision"),
				projectRevisionId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		query: Type.String({ minLength: 1 }),
		hits: Type.Array(
			Type.Object(
				{
					identity: identitySchema,
					path: Type.String({ minLength: 1 }),
					artifactVersionId: Type.Optional(Type.String({ minLength: 1 })),
					contentSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
					match: Type.Union([Type.Literal("content"), Type.Literal("identity")]),
					matchedTerms: Type.Array(Type.String({ minLength: 1 })),
					range: Type.Optional(
						Type.Object(
							{ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }) },
							{ additionalProperties: false },
						),
					),
					score: Type.Number(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const codePointSpanSchema = Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 0 })]);
const sourceCoverageSchema = Type.Object(
	{
		materialSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		covered: Type.Array(codePointSpanSchema),
		gaps: Type.Array(codePointSpanSchema),
		notes: Type.Array(
			Type.Object(
				{ id: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }), span: codePointSpanSchema },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const sourceSummarySchema = Type.Object(
	{
		sourceId: Type.String({ minLength: 1 }),
		state: Type.Union([Type.Literal("ingested"), Type.Literal("extracted")]),
		name: Type.String({ minLength: 1 }),
		encoding: Type.Optional(Type.String({ minLength: 1 })),
		originalByteLength: Type.Integer({ minimum: 1 }),
		materialCodePoints: Type.Integer({ minimum: 1 }),
		/** 从 `source/<id>/notes/*.md` 的 span 派生的读取覆盖率；只算 material_sha256 等于当前材料的笔记。 */
		coverage: Type.Optional(sourceCoverageSchema),
		check: Type.Optional(
			Type.Object(
				{
					passed: Type.Boolean(),
					openContractIds: Type.Array(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const SuimCliSourceListDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revisionId: Type.String({ minLength: 1 }),
		sources: Type.Array(sourceSummarySchema),
	},
	{ additionalProperties: false },
);

export const SuimCliSourceIngestDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revision: revisionSchema,
		source: sourceSummarySchema,
	},
	{ additionalProperties: false },
);

export const SuimCliReviewListDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revisionId: Type.String({ minLength: 1 }),
		reviews: Type.Array(reviewSummarySchema),
	},
	{ additionalProperties: false },
);

export const SuimCliReviewShowDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revisionId: Type.String({ minLength: 1 }),
		review: Type.Object(
			{
				...reviewSummarySchema.properties,
				/** 完整 ReviewDraft：host 消费 finding 不必再解析文件；形状由 Story Language 的 ReviewDraft schema 定义。 */
				draft: Type.Object(
					{
						verdict: Type.String({ minLength: 1 }),
						summary: Type.String({ minLength: 1 }),
						findings: Type.Array(Type.Record(Type.String(), Type.Unknown())),
						uncovered: Type.Array(Type.String()),
						uncertainties: Type.Array(Type.String()),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

const releaseStateSchema = Type.Union([
	Type.Literal("missing"),
	Type.Literal("current"),
	Type.Literal("stale"),
	Type.Literal("invalid"),
]);

const contextArtifactPathSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		range: Type.Optional(
			Type.Object(
				{ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 1 }) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** `context compile <task>`：按任务编译给 host agent 的选择性 Context；输入引用的作品文件按路径列出。 */
export const SuimCliContextCompileDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revisionId: Type.String({ minLength: 1 }),
		task: Type.String({ minLength: 1 }),
		systemPrompt: Type.String({ minLength: 1 }),
		text: Type.String({ minLength: 1 }),
		artifacts: Type.Array(contextArtifactPathSchema),
		outputPath: Type.Optional(Type.String({ minLength: 1 })),
		write: Type.Optional(
			Type.Object(
				{
					targetPath: Type.String({ minLength: 1 }),
					previousStoryBeatId: Type.Optional(Type.String({ minLength: 1 })),
					nextStoryBeatId: Type.Optional(Type.String({ minLength: 1 })),
					hasCurrentText: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		review: Type.Optional(
			Type.Object(
				{
					layer: reviewLayerSchema,
					storyBeatIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
					sourceId: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		/** source:read 任务：本次材料范围与笔记 frontmatter 应写的 material_sha256。 */
		source: Type.Optional(
			Type.Object(
				{
					sourceId: Type.String({ minLength: 1 }),
					span: Type.Object({ start: Type.Integer(), end: Type.Integer() }, { additionalProperties: false }),
					materialSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
				},
				{ additionalProperties: false },
			),
		),
		/** design:character / family / volume 视图：主体与它覆盖的 Beat。 */
		design: Type.Optional(
			Type.Object(
				{
					kind: Type.Union([
						Type.Literal("character"),
						Type.Literal("family"),
						Type.Literal("volume"),
						Type.Literal("state"),
					]),
					id: Type.String({ minLength: 1 }),
					phase: Type.Optional(
						Type.Union([Type.Literal("before"), Type.Literal("changes"), Type.Literal("after")]),
					),
					subject: Type.Optional(
						Type.Object(
							{
								kind: Type.Union([
									Type.Literal("character"),
									Type.Literal("resource"),
									Type.Literal("contract"),
								]),
								id: Type.String({ minLength: 1 }),
							},
							{ additionalProperties: false },
						),
					),
					atStoryBeatId: Type.Optional(Type.String({ minLength: 1 })),
					storyBeatIds: Type.Array(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** `text check <beat-id>`：在当前 checkout（可 dirty）上跑单 Beat 的确定性检查。 */
export const SuimCliTextCheckDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		baseRevisionId: Type.String({ minLength: 1 }),
		state: Type.Union([Type.Literal("clean"), Type.Literal("dirty")]),
		storyBeatId: Type.String({ minLength: 1 }),
		passed: Type.Boolean(),
		codePoints: Type.Integer({ minimum: 0 }),
		failures: Type.Array(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

/** `design impact <kind:id>`：修改某个 Design 主体时可能受影响的候选召回。 */
export const SuimCliDesignImpactDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		baseRevisionId: Type.String({ minLength: 1 }),
		state: Type.Union([Type.Literal("clean"), Type.Literal("dirty")]),
		impact: Type.Object(
			{
				subject: Type.Object(
					{
						kind: Type.Union([
							Type.Literal("beat"),
							Type.Literal("character"),
							Type.Literal("place"),
							Type.Literal("resource"),
							Type.Literal("world"),
							Type.Literal("contract"),
							Type.Literal("intent"),
						]),
						id: Type.String({ minLength: 1 }),
					},
					{ additionalProperties: false },
				),
				storyBeatIds: Type.Array(Type.String({ minLength: 1 })),
				dependentStoryBeatIds: Type.Array(Type.String({ minLength: 1 })),
				characterIds: Type.Array(Type.String({ minLength: 1 })),
				placeIds: Type.Array(Type.String({ minLength: 1 })),
				resourceIds: Type.Array(Type.String({ minLength: 1 })),
				worldIds: Type.Array(Type.String({ minLength: 1 })),
				contractIds: Type.Array(Type.String({ minLength: 1 })),
				intentIds: Type.Array(Type.String({ minLength: 1 })),
				paths: Type.Array(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/** `review record`：host 完成的 ReviewDraft 经与 submit_review 同一个校验器后写成 `review/<id>.md`，随下一次 commit 进版本。 */
export const SuimCliReviewRecordDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		/** 审的版本，即当前 head。 */
		revisionId: Type.String({ minLength: 1 }),
		review: reviewSummarySchema,
	},
	{ additionalProperties: false },
);

/** `review schema`：ReviewDraft 的 JSON Schema，给支持结构化输出的 host runtime。 */
/** `design guide`：由 schema 与硬状态 profile 渲染的 Target Story Language 机器形状，给 host 写 Design 前查字段用。 */
export const SuimCliDesignGuideDataSchema = Type.Object(
	{ guide: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

export const SuimCliReviewSchemaDataSchema = Type.Object(
	{ schema: Type.Record(Type.String(), Type.Unknown()) },
	{ additionalProperties: false },
);

export const SuimCliReleaseStatusDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		revisionId: Type.String({ minLength: 1 }),
		state: releaseStateSchema,
		chapterCount: Type.Integer({ minimum: 0 }),
		reviewVerdict: Type.Optional(reviewVerdictSchema),
		reason: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const SuimCliReleasePublishDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		created: Type.Boolean(),
		revision: revisionSchema,
		manifest: Type.Object(
			{
				path: Type.Literal("release/manifest.yaml"),
				/** 发布所依据的版本。 */
				revision: Type.String({ minLength: 1 }),
				/** 绑定的全书正文审稿 id。 */
				storyTextReview: Type.Optional(Type.String({ minLength: 1 })),
				layout: Type.Object(
					{
						targetCodePoints: Type.Integer({ minimum: 1 }),
						minCodePoints: Type.Integer({ minimum: 1 }),
						maxCodePoints: Type.Integer({ minimum: 1 }),
					},
					{ additionalProperties: false },
				),
				chapters: Type.Array(
					Type.Object(
						{
							id: Type.String({ minLength: 1 }),
							path: Type.String({ minLength: 1 }),
							codePoints: Type.Integer({ minimum: 1 }),
							sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		reviewVerdict: Type.Optional(reviewVerdictSchema),
	},
	{ additionalProperties: false },
);

/** `session send` / `session resume`：一个 turn 跑完后的 session 状态与本轮的作者可见交付。 */
export const SuimCliSessionTurnDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		session: sessionSummarySchema,
		headRevisionId: Type.String({ minLength: 1 }),
		/** 本 turn 里 Agent 的最后一条完整回复；模型停下就是 turn 结束。 */
		reply: Type.String(),
	},
	{ additionalProperties: false },
);

export const SuimCliSessionStatusDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		session: sessionSummarySchema,
	},
	{ additionalProperties: false },
);

/** `rank`：盲读评委对同一 Beat 多版正文的合并排序；每轮的原始结果是 session 的 Task 结果。 */
export const SuimCliRankDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		sessionId: Type.String({ minLength: 1 }),
		headRevisionId: Type.String({ minLength: 1 }),
		storyBeatId: Type.String({ minLength: 1 }),
		rounds: Type.Integer({ minimum: 1 }),
		/** 评委口径：constitution 按本作宪法与写作准则评本作的几份候选；reader 不带本作准则、只看前文，对照原作或参照稿。 */
		rubric: Type.Union([Type.Literal("constitution"), Type.Literal("reader")]),
		judge: Type.Object(
			{
				provider: Type.String({ minLength: 1 }),
				model: Type.String({ minLength: 1 }),
				/** 评委与 Writer 同一个模型时自评倾向不可忽略，结果只能当参考。 */
				sameModelAsWriter: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		ranking: Type.Array(
			Type.Object(
				{
					label: Type.String({ minLength: 1 }),
					averageRank: Type.Number(),
					ranks: Type.Array(Type.Integer({ minimum: 1 })),
					reasons: Type.Array(Type.String()),
					flaws: Type.Array(Type.String()),
				},
				{ additionalProperties: false },
			),
			{ minItems: 2 },
		),
		roundResultObjectIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const SuimCliSessionListDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		sessions: Type.Array(sessionSummarySchema),
	},
	{ additionalProperties: false },
);

export const SuimCliSessionEventsDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		sessionId: Type.String({ minLength: 1 }),
		events: Type.Array(SessionEventSchema),
	},
	{ additionalProperties: false },
);

export const SuimCliSessionShowDataSchema = Type.Object(
	{
		projectId: Type.String({ minLength: 1 }),
		session: sessionSummarySchema,
		tasks: Type.Array(taskSummarySchema),
	},
	{ additionalProperties: false },
);

/**
 * 命令目录（ADR-0009 决定 26）：每条命令绑定自己的输出 schema。CLI 输出前按它校验，
 * 测试与 host 也按它读取；Cloud Domain API 与桌面端 IPC 是同一目录的另一种传输。
 */
export const SUIM_CLI_COMMAND_DATA = {
	"project.init": SuimCliProjectInitDataSchema,
	"project.open": SuimCliProjectDataSchema,
	"project.status": SuimCliProjectStatusDataSchema,
	"project.diff": SuimCliDiffDataSchema,
	"project.check": SuimCliCheckDataSchema,
	"project.commit": SuimCliCommitDataSchema,
	"project.history": SuimCliHistoryDataSchema,
	"project.rollback": SuimCliRollbackDataSchema,
	"project.export": SuimCliExportDataSchema,
	"project.update": SuimCliProjectUpdateDataSchema,
	"read.search": SuimCliSearchDataSchema,
	"context.compile": SuimCliContextCompileDataSchema,
	"text.check": SuimCliTextCheckDataSchema,
	"design.impact": SuimCliDesignImpactDataSchema,
	"design.guide": SuimCliDesignGuideDataSchema,
	"source.ingest": SuimCliSourceIngestDataSchema,
	"source.list": SuimCliSourceListDataSchema,
	"review.list": SuimCliReviewListDataSchema,
	"review.show": SuimCliReviewShowDataSchema,
	"review.record": SuimCliReviewRecordDataSchema,
	"review.schema": SuimCliReviewSchemaDataSchema,
	"release.status": SuimCliReleaseStatusDataSchema,
	"release.publish": SuimCliReleasePublishDataSchema,
	"session.send": SuimCliSessionTurnDataSchema,
	"session.resume": SuimCliSessionTurnDataSchema,
	"session.interrupt": SuimCliSessionStatusDataSchema,
	"session.list": SuimCliSessionListDataSchema,
	"session.show": SuimCliSessionShowDataSchema,
	"session.events": SuimCliSessionEventsDataSchema,
	rank: SuimCliRankDataSchema,
	"cloud.checkout": SuimCliCloudCheckoutDataSchema,
	"cloud.import": SuimCliCloudImportDataSchema,
	"cloud.link": SuimCliCloudBindingDataSchema,
	"cloud.status": SuimCliCloudStatusDataSchema,
	"cloud.push": SuimCliCloudSyncDataSchema,
	"cloud.pull": SuimCliCloudSyncDataSchema,
	"cloud.unlink": SuimCliCloudBindingDataSchema,
} as const satisfies Record<SuimCliCommand, TSchema>;

/** 成功响应是按命令 discriminated 的联合：`data` 与 `command` 绑定，不再是一个松散的 schema 联合。 */
export const SuimCliSuccessSchema = Type.Union(
	SUIM_CLI_COMMANDS.map((command) =>
		Type.Object(
			{
				protocolVersion: Type.Literal(SUIM_CLI_PROTOCOL_VERSION),
				command: Type.Literal(command),
				ok: Type.Literal(true),
				data: SUIM_CLI_COMMAND_DATA[command],
			},
			{ additionalProperties: false },
		),
	),
);

export const SuimCliErrorSchema = Type.Object(
	{
		protocolVersion: Type.Literal(SUIM_CLI_PROTOCOL_VERSION),
		command: Type.Union([commandLiterals, Type.Literal("usage")]),
		ok: Type.Literal(false),
		error: Type.Object(
			{
				code: Type.String({ minLength: 1 }),
				message: Type.String({ minLength: 1 }),
				retryable: Type.Boolean(),
				/** 绑定期一次发现的全部问题（`message` 只是汇总加第一处）；没有逐条诊断的错误不带这个字段。 */
				diagnostics: Type.Optional(Type.Array(checkDiagnosticSchema)),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const SuimCliResponseSchema = Type.Union([SuimCliSuccessSchema, SuimCliErrorSchema]);

export interface SuimCliSuccess {
	protocolVersion: typeof SUIM_CLI_PROTOCOL_VERSION;
	command: SuimCliCommand;
	ok: true;
	data: unknown;
}

/** `session send --events` 在最终响应之前逐行输出的 SessionEvent 信封。 */
export const SuimCliEventSchema = Type.Object(
	{
		protocolVersion: Type.Literal(SUIM_CLI_PROTOCOL_VERSION),
		command: commandLiterals,
		event: SessionEventSchema,
	},
	{ additionalProperties: false },
);

export interface SuimCliEvent {
	protocolVersion: typeof SUIM_CLI_PROTOCOL_VERSION;
	command: SuimCliCommand;
	event: SessionEvent;
}

export interface SuimCliError {
	protocolVersion: typeof SUIM_CLI_PROTOCOL_VERSION;
	command: SuimCliCommand | "usage";
	ok: false;
	error: { code: string; message: string; retryable: boolean; diagnostics?: Static<typeof checkDiagnosticSchema>[] };
}
