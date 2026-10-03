import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { STORY_BEAT_ID_PATTERN } from "./book-patterns.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { formatDiagnostic, SuimError } from "./errors.js";
import { LOCAL_ID_FRAGMENT } from "./local-id.js";
import { parseMarkdownDocument, renderMarkdownDocument } from "./markdown.js";
import {
	parseReviewDraft,
	REVIEW_REPAIR_LAYERS,
	REVIEW_SEVERITIES,
	REVIEW_VERDICTS,
	type ReviewDraft,
	type ReviewFinding,
} from "./review.js";

/**
 * `review/<id>.md`：一份审稿就是一个普通作品文件（[evidence 派生设计](../../../docs/derived-evidence-design.md) 3.1）。
 * frontmatter 记它审的是哪一层、哪个范围、审的时候主体文件长什么样（`subjects`）与结论；正文是给作者看的摘要。
 * 「这份审稿对当前稿还算不算数」不存文件，由 `reviewCurrency` 拿 `subjects` 与当前候选比出来。
 */
export const REVIEW_LAYERS = ["design", "text", "source"] as const;
export type ReviewLayer = (typeof REVIEW_LAYERS)[number];

export const REVIEW_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$";
/**
 * `revision` 的特殊值：审的是 checkout 里尚未提交的候选，提交前不知道 revision id。
 *
 * 它**只是个标签**：时效由 `subjects` 的摘要决定，不由这个字段决定。2026-09-16 的第一次真实对话
 * 证明按版本判定必然漏判——Agent 的自然循环是「审 → 按意见改 → 一次提交」，审稿文件与改过的正文
 * 落在同一个 revision，比较区间为空，于是一份已经过时的审稿被判成 current
 * （[记录](../../../docs/validation/2026-09-16-first-real-session/README.md)）。
 */
export const CANDIDATE_REVISION = "candidate";

/** `subjects` 的摘要格式：`sha256:` 前缀既自描述，又避免 YAML 把纯数字的 hex 解析成数字。 */
export const REVIEW_SUBJECT_DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
const SOURCE_SCOPE_PATTERN = `^source:${LOCAL_ID_FRAGMENT}$`;

function literals<T extends string>(values: readonly T[]) {
	return Type.Unsafe<T>(Type.Union(values.map((value) => Type.Literal(value))));
}

const ReviewFindingWireSchema = Type.Object(
	{
		severity: literals(REVIEW_SEVERITIES),
		anchor: Type.Union([
			Type.Object(
				{
					kind: Type.Literal("artifact"),
					path: Type.String({ minLength: 1 }),
					pointer: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("source_span"),
					source_id: Type.String({ pattern: `^${LOCAL_ID_FRAGMENT}$` }),
					start: Type.Integer({ minimum: 0 }),
					end: Type.Integer({ minimum: 1 }),
				},
				{ additionalProperties: false },
			),
		]),
		issue: Type.String({ minLength: 1 }),
		evidence: Type.String({ minLength: 1 }),
		repair_layer: literals(REVIEW_REPAIR_LAYERS),
		suggestion: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const ReviewFileFrontmatterSchema = Type.Object(
	{
		layer: Type.Union([Type.Literal("design"), Type.Literal("text"), Type.Literal("source")]),
		/** `book`、Beat id 列表，或 `source:<id>`。 */
		scope: Type.Union([
			Type.Literal("book"),
			Type.Array(Type.String({ pattern: STORY_BEAT_ID_PATTERN }), { minItems: 1 }),
			Type.String({ pattern: SOURCE_SCOPE_PATTERN }),
		]),
		/** 审的是哪个 Canon revision，或 `candidate`（尚未提交的候选）。只是标签，时效看 `subjects`。 */
		revision: Type.String({ minLength: 1 }),
		/** 审的时候每个主体文件的内容摘要，路径 → `sha256:<hex>`。时效就是拿它与当前候选比。 */
		subjects: Type.Record(Type.String({ minLength: 1 }), Type.String({ pattern: REVIEW_SUBJECT_DIGEST_PATTERN })),
		verdict: literals(REVIEW_VERDICTS),
		findings: Type.Array(ReviewFindingWireSchema),
		uncovered: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		uncertainties: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ $id: "https://suiming.dev/schemas/review-file-v1.json", additionalProperties: false },
);

export type ReviewFileFrontmatter = Static<typeof ReviewFileFrontmatterSchema>;

export type ReviewScope =
	| { kind: "book" }
	| { kind: "beats"; storyBeatIds: string[] }
	| { kind: "source"; sourceId: string };

export interface ReviewFile {
	layer: ReviewLayer;
	scope: ReviewScope;
	revision: string;
	/** 路径 → `sha256:<hex>`，审的时候主体文件的样子。 */
	subjects: ReadonlyMap<string, string>;
	draft: ReviewDraft;
}

function invalid(path: string, message: string, pointer = ""): never {
	throw new SuimError("invalid_review_file", `${path}: ${message}`, [{ path, pointer, message }]);
}

function findingFromWire(finding: Static<typeof ReviewFindingWireSchema>): ReviewFinding {
	return {
		severity: finding.severity,
		anchor:
			finding.anchor.kind === "artifact"
				? {
						kind: "artifact",
						path: finding.anchor.path,
						...(finding.anchor.pointer === undefined ? {} : { pointer: finding.anchor.pointer }),
					}
				: {
						kind: "source_span",
						sourceId: finding.anchor.source_id,
						start: finding.anchor.start,
						end: finding.anchor.end,
					},
		issue: finding.issue,
		evidence: finding.evidence,
		repairLayer: finding.repair_layer,
		...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
	};
}

function findingToWire(finding: ReviewFinding): Static<typeof ReviewFindingWireSchema> {
	return {
		severity: finding.severity,
		anchor:
			finding.anchor.kind === "artifact"
				? {
						kind: "artifact",
						path: finding.anchor.path,
						...(finding.anchor.pointer === undefined ? {} : { pointer: finding.anchor.pointer }),
					}
				: {
						kind: "source_span",
						source_id: finding.anchor.sourceId,
						start: finding.anchor.start,
						end: finding.anchor.end,
					},
		issue: finding.issue,
		evidence: finding.evidence,
		repair_layer: finding.repairLayer,
		...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
	};
}

export function parseReviewScope(value: ReviewFileFrontmatter["scope"]): ReviewScope {
	if (value === "book") return { kind: "book" };
	if (Array.isArray(value)) return { kind: "beats", storyBeatIds: [...value] };
	return { kind: "source", sourceId: value.slice("source:".length) };
}

export function renderReviewScope(scope: ReviewScope): ReviewFileFrontmatter["scope"] {
	if (scope.kind === "book") return "book";
	if (scope.kind === "beats") return [...scope.storyBeatIds];
	return `source:${scope.sourceId}`;
}

function requireScopeForLayer(layer: ReviewLayer, scope: ReviewScope, path: string): void {
	if (layer === "source" && scope.kind !== "source")
		invalid(path, "source review scope must be source:<id>", "/scope");
	if (layer !== "source" && scope.kind === "source")
		invalid(path, `${layer} review scope cannot be a source`, "/scope");
	if (layer === "design" && scope.kind !== "book") invalid(path, "design review scope must be book", "/scope");
}

export function parseReviewFile(markdown: string, path: string): ReviewFile {
	const document = parseMarkdownDocument(markdown, path);
	const frontmatter = document.frontmatter;
	if (!Value.Check(ReviewFileFrontmatterSchema, frontmatter)) {
		const diagnostics = schemaDiagnostics(frontmatter, [...Value.Errors(ReviewFileFrontmatterSchema, frontmatter)], {
			path,
		});
		throw new SuimError(
			"invalid_review_file",
			diagnostics.map(formatDiagnostic).join("; ") || `${path} frontmatter does not match the review schema`,
			diagnostics,
		);
	}
	if (document.body.length === 0) invalid(path, "review summary body must not be empty");
	const scope = parseReviewScope(frontmatter.scope);
	requireScopeForLayer(frontmatter.layer, scope, path);
	const draft = parseReviewDraft({
		verdict: frontmatter.verdict,
		summary: document.body,
		findings: frontmatter.findings.map(findingFromWire),
		uncovered: frontmatter.uncovered ?? [],
		uncertainties: frontmatter.uncertainties ?? [],
	});
	return {
		layer: frontmatter.layer,
		scope,
		revision: frontmatter.revision,
		subjects: new Map(Object.entries(frontmatter.subjects)),
		draft,
	};
}

export function renderReviewFile(review: ReviewFile): string {
	const draft = parseReviewDraft(review.draft);
	const frontmatter: ReviewFileFrontmatter = {
		layer: review.layer,
		scope: renderReviewScope(review.scope),
		revision: review.revision,
		subjects: Object.fromEntries([...review.subjects].sort(([left], [right]) => (left < right ? -1 : 1))),
		verdict: draft.verdict,
		findings: draft.findings.map(findingToWire),
		...(draft.uncovered.length === 0 ? {} : { uncovered: draft.uncovered }),
		...(draft.uncertainties.length === 0 ? {} : { uncertainties: draft.uncertainties }),
	};
	return renderMarkdownDocument(frontmatter, draft.summary);
}
