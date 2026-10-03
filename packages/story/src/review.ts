import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { LOCAL_ID_PATTERN } from "./book-schema.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { formatDiagnostic, SuimError } from "./errors.js";

export const REVIEW_VERDICTS = ["pass", "revise", "block", "insufficient_context"] as const;
export const REVIEW_SEVERITIES = ["note", "minor", "major", "blocker"] as const;
export const REVIEW_REPAIR_LAYERS = ["source", "design", "text"] as const;

/** 字面量枚举：schema 是 literal 的 union，静态类型直接用 T，不让 TypeBox 从数组推成 never。 */
function literals<T extends string>(values: readonly T[]) {
	return Type.Unsafe<T>(Type.Union(values.map((value) => Type.Literal(value))));
}

const ArtifactReviewAnchorSchema = Type.Object(
	{
		kind: Type.Literal("artifact"),
		path: Type.String({ minLength: 1 }),
		pointer: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const SourceSpanReviewAnchorSchema = Type.Object(
	{
		kind: Type.Literal("source_span"),
		sourceId: Type.String({ pattern: LOCAL_ID_PATTERN }),
		start: Type.Integer({ minimum: 0 }),
		end: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const ReviewAnchorSchema = Type.Union([ArtifactReviewAnchorSchema, SourceSpanReviewAnchorSchema]);

export const ReviewFindingSchema = Type.Object(
	{
		severity: literals(REVIEW_SEVERITIES),
		anchor: ReviewAnchorSchema,
		issue: Type.String({ minLength: 1 }),
		evidence: Type.String({ minLength: 1 }),
		repairLayer: literals(REVIEW_REPAIR_LAYERS),
		suggestion: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const ReviewDraftSchema = Type.Object(
	{
		verdict: literals(REVIEW_VERDICTS),
		summary: Type.String({ minLength: 1 }),
		findings: Type.Array(ReviewFindingSchema, {
			description: "Must be empty for pass and non-empty for revise; block requires a blocker finding.",
		}),
		uncovered: Type.Array(Type.String({ minLength: 1 }), {
			description: "Must be empty for pass; required with uncertainties when context is insufficient.",
		}),
		uncertainties: Type.Array(Type.String({ minLength: 1 })),
	},
	{
		$id: "https://suiming.dev/schemas/review-draft-v1.json",
		additionalProperties: false,
	},
);

export type ReviewAnchor = Static<typeof ReviewAnchorSchema>;
export type ReviewFinding = Static<typeof ReviewFindingSchema>;
export type ReviewDraft = Static<typeof ReviewDraftSchema>;
export type ReviewVerdict = ReviewDraft["verdict"];
export type ReviewSeverity = ReviewFinding["severity"];
export type ReviewRepairLayer = ReviewFinding["repairLayer"];

function invalid(message: string, pointer: string): never {
	throw new SuimError("invalid_review_draft", message, [{ path: "ReviewDraft", pointer, message }]);
}

function validateReviewDraftSemantics(draft: ReviewDraft): void {
	if (draft.verdict === "pass" && draft.findings.length > 0) {
		invalid("pass ReviewDraft cannot contain findings", "/findings");
	}
	if (draft.verdict === "pass" && draft.uncovered.length > 0) {
		invalid("pass ReviewDraft cannot declare uncovered scope", "/uncovered");
	}
	if (draft.verdict === "revise" && draft.findings.length === 0) {
		invalid("revise ReviewDraft requires at least one finding", "/findings");
	}
	if (draft.verdict === "block" && !draft.findings.some((finding) => finding.severity === "blocker")) {
		invalid("block ReviewDraft requires a blocker finding", "/findings");
	}
	if (draft.verdict === "insufficient_context" && draft.uncovered.length === 0 && draft.uncertainties.length === 0) {
		invalid("insufficient_context must identify uncovered scope or uncertainty", "/uncovered");
	}
	for (const [index, finding] of draft.findings.entries()) {
		if (finding.anchor.kind === "artifact") {
			const path = finding.anchor.path;
			if (
				path.startsWith("/") ||
				path.endsWith("/") ||
				path.includes("\\") ||
				path.split("/").some((part) => part === "" || part === "." || part === "..")
			) {
				invalid("artifact anchor path must be a safe open-package relative path", `/findings/${index}/anchor/path`);
			}
		} else if (finding.anchor.start >= finding.anchor.end) {
			invalid("source_span anchor start must be less than end", `/findings/${index}/anchor`);
		}
	}
}

export function parseReviewDraft(input: unknown): ReviewDraft {
	if (!Value.Check(ReviewDraftSchema, input)) {
		const diagnostics = schemaDiagnostics(input, [...Value.Errors(ReviewDraftSchema, input)], {
			path: "ReviewDraft",
		});
		throw new SuimError(
			"invalid_review_draft",
			diagnostics.map(formatDiagnostic).join("; ") || "ReviewDraft does not match its schema",
			diagnostics,
		);
	}
	const draft = structuredClone(input) as ReviewDraft;
	validateReviewDraftSemantics(draft);
	return draft;
}
