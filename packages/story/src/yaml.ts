import { parse } from "yaml";
import { SuimError } from "./errors.js";

interface YamlLocation {
	line?: number;
	col?: number;
}

function yamlLocation(error: unknown): YamlLocation {
	if (error === null || typeof error !== "object") return {};
	const linePos = (error as { linePos?: unknown }).linePos;
	if (!Array.isArray(linePos) || linePos.length === 0) return {};
	const first = linePos[0];
	if (first === null || typeof first !== "object") return {};
	const line = (first as { line?: unknown }).line;
	const col = (first as { col?: unknown }).col;
	return {
		...(typeof line === "number" ? { line } : {}),
		...(typeof col === "number" ? { col } : {}),
	};
}

export function parseYaml(text: string, path: string, options: { code?: string; lineOffset?: number } = {}): unknown {
	try {
		return parse(text);
	} catch (error) {
		const location = yamlLocation(error);
		const firstLine = error instanceof Error ? (error.message.split("\n", 1)[0] ?? "invalid YAML") : "invalid YAML";
		const message = firstLine.replace(/\s+at line \d+, column \d+:?$/, "");
		const diagnostic = {
			path,
			...(location.line === undefined ? {} : { line: location.line + (options.lineOffset ?? 0) }),
			...(location.col === undefined ? {} : { column: location.col }),
			message,
			hint: "先修好 YAML 语法，再校验文档结构",
		};
		throw new SuimError(options.code ?? "invalid_document", message, [diagnostic]);
	}
}
