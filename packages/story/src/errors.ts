export interface Diagnostic {
	path?: string;
	pointer?: string;
	line?: number;
	column?: number;
	message: string;
	expected?: string;
	actual?: unknown;
	hint?: string;
	/** 缺省为 error；warning 不阻塞绑定或提交。 */
	severity?: "error" | "warning";
}

function printableActual(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === undefined) return "undefined";
	return JSON.stringify(value);
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
	const lineColumn =
		diagnostic.line === undefined
			? ""
			: `:${diagnostic.line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`}`;
	const pointer =
		diagnostic.pointer === undefined
			? ""
			: `${diagnostic.path === undefined && lineColumn === "" ? "" : "#"}${diagnostic.pointer}`;
	const location = `${diagnostic.path ?? ""}${lineColumn}${pointer}`;
	const severity = diagnostic.severity === "warning" ? "警告：" : "";
	return `${location === "" ? "" : `${location}：`}${severity}${diagnosticDetail(diagnostic)}`;
}

/** 不含位置与严重程度的那半句：消息、应为 / 实际、提示。界面已按文件与严重程度归类时只显示它。 */
export function diagnosticDetail(diagnostic: Diagnostic): string {
	return [
		diagnostic.message,
		diagnostic.expected === undefined ? undefined : `应为 ${diagnostic.expected}`,
		diagnostic.actual === undefined ? undefined : `实际为 ${printableActual(diagnostic.actual)}`,
		diagnostic.hint === undefined ? undefined : `提示：${diagnostic.hint}`,
	]
		.filter((item): item is string => item !== undefined)
		.join("；");
}

export class SuimError extends Error {
	readonly code: string;
	readonly diagnostics: Diagnostic[];

	constructor(code: string, message: string, diagnostics: readonly Diagnostic[] = []) {
		super(message);
		this.name = "SuimError";
		this.code = code;
		this.diagnostics = [...diagnostics];
	}
}
