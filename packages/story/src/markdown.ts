import { stringify } from "yaml";
import { BookParseError } from "./book-error.js";
import { parseYaml } from "./yaml.js";

export interface MarkdownDocument {
	frontmatter: Record<string, unknown>;
	body: string;
}

export function renderMarkdownDocument(frontmatter: Readonly<Record<string, unknown>>, body: string): string {
	const content = body.trim();
	if (content.length === 0) throw new BookParseError("invalid_document", "Markdown 正文不能为空");
	if (Object.keys(frontmatter).length === 0) return `${content}\n`;
	return `---\n${stringify(frontmatter).trimEnd()}\n---\n${content}\n`;
}

export function parseMarkdownDocument(markdown: string, path: string): MarkdownDocument {
	const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: {}, body: normalized.trim() };
	}
	const end = normalized.indexOf("\n---\n", 4);
	if (end === -1) {
		throw new BookParseError("invalid_document", `${path} 的 YAML frontmatter 没有结束`, [
			{
				path,
				line: 1,
				message: "YAML frontmatter 没有结束",
				hint: "在单独一行加上结束的 ---",
			},
		]);
	}
	let input = parseYaml(normalized.slice(4, end), path, { lineOffset: 1 });
	if (input === null || input === undefined) input = {};
	if (typeof input !== "object" || Array.isArray(input)) {
		throw new BookParseError("invalid_document", `${path} 的 frontmatter 必须是键值映射`, [
			{
				path,
				pointer: "/frontmatter",
				message: "frontmatter 必须是键值映射",
				expected: "YAML object",
			},
		]);
	}
	return {
		frontmatter: input as Record<string, unknown>,
		body: normalized.slice(end + 5).trim(),
	};
}
