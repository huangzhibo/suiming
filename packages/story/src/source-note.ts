import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { SHA256_PATTERN } from "./book-schema.js";
import { schemaDiagnostics } from "./diagnostics.js";
import { formatDiagnostic, SuimError } from "./errors.js";
import { parseMarkdownDocument } from "./markdown.js";

/**
 * `source/<id>/notes/<n>.md`：Source Reader 读过某段原文后留下的 handoff，是普通作品文件
 * （[Story Language source](../../../story-language/source.md)「笔记与覆盖率」）。frontmatter 记它覆盖的码点区间与
 * 当时 `material.txt` 的内容 sha；「读过哪些范围、还缺哪些」由 `sourceCoverage` 按 notes 的 span 派生。
 */
export const SourceNoteFrontmatterSchema = Type.Object(
	{
		/** [start, end)，原文码点区间。 */
		span: Type.Tuple([Type.Integer({ minimum: 0 }), Type.Integer({ minimum: 1 })]),
		material_sha256: Type.String({ pattern: SHA256_PATTERN }),
	},
	{ $id: "https://suiming.dev/schemas/source-note-v1.json", additionalProperties: false },
);

export type SourceNoteFrontmatter = Static<typeof SourceNoteFrontmatterSchema>;

export interface SourceNote {
	span: { start: number; end: number };
	materialSha256: string;
	handoff: string;
}

export function parseSourceNote(markdown: string, path: string): SourceNote {
	const document = parseMarkdownDocument(markdown, path);
	const frontmatter = document.frontmatter;
	if (!Value.Check(SourceNoteFrontmatterSchema, frontmatter)) {
		const diagnostics = schemaDiagnostics(frontmatter, [...Value.Errors(SourceNoteFrontmatterSchema, frontmatter)], {
			path,
		});
		throw new SuimError(
			"invalid_source_note",
			diagnostics.map(formatDiagnostic).join("; ") || `${path} frontmatter does not match the source note schema`,
			diagnostics,
		);
	}
	const [start, end] = frontmatter.span;
	if (start >= end)
		throw new SuimError("invalid_source_note", `${path}: span start must be less than end`, [
			{ path, pointer: "/span", message: "span start must be less than end" },
		]);
	if (document.body.length === 0)
		throw new SuimError("invalid_source_note", `${path}: handoff body must not be empty`, [
			{ path, pointer: "", message: "handoff body must not be empty" },
		]);
	return { span: { start, end }, materialSha256: frontmatter.material_sha256, handoff: document.body };
}
