import { ToolRejection } from "./tool.js";

const MAX_READ_BYTES = 50 * 1024;

/** 行号与列号均从 1 开始，列按 Unicode 码点计；长段落也能准确接着读。 */
export function readWindow(content: string, params: { offset?: number; column?: number; limit?: number }) {
	const lines = content.split("\n");
	let line = (params.offset ?? 1) - 1;
	let column = (params.column ?? 1) - 1;
	if (line >= lines.length) throw new ToolRejection("invalid_read_range", `文件只有 ${lines.length} 行`);
	if (column > Array.from(lines[line] ?? "").length)
		throw new ToolRejection("invalid_read_range", "column 超出这一行的码点范围");
	const end = Math.min(lines.length, line + (params.limit ?? 2000));
	const output: string[] = [];
	let bytes = 0;
	for (; line < end; line++) {
		const prefix = `${line + 1}${column > 0 ? `[${column + 1}]` : ""}: `;
		const overhead = Buffer.byteLength(prefix) + (output.length ? 1 : 0);
		const points = Array.from(lines[line] ?? "");
		if (bytes + overhead + 4 > MAX_READ_BYTES) break;
		bytes += overhead;
		const start = column;
		while (column < points.length) {
			const size = Buffer.byteLength(points[column] as string);
			if (bytes + size > MAX_READ_BYTES) break;
			bytes += size;
			column++;
		}
		output.push(prefix + points.slice(start, column).join(""));
		if (column < points.length) break;
		column = 0;
	}
	return {
		text: output.join("\n"),
		...(line < lines.length ? { next: { offset: line + 1, column: column + 1 } } : {}),
	};
}
