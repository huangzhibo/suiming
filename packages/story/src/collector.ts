import { BookParseError } from "./book-error.js";
import type { Diagnostic } from "./errors.js";
import { SuimError } from "./errors.js";

/**
 * 累积一次绑定或检查中发现的全部诊断。
 *
 * Checker 与 parser 不再首错即停：每个文档、每条引用、每个硬状态变化各自报告问题，
 * 最后由 `throwIfFailed` 一次抛出带完整诊断列表的错误。warning 不构成失败。
 */
export class DiagnosticCollector {
	readonly errors: Diagnostic[] = [];
	readonly warnings: Diagnostic[] = [];
	#firstCode: string | undefined;

	get failed(): boolean {
		return this.errors.length > 0;
	}

	get code(): string | undefined {
		return this.#firstCode;
	}

	report(code: string, diagnostics: readonly Diagnostic[]): void {
		this.#firstCode ??= code;
		for (const diagnostic of diagnostics) this.errors.push({ ...diagnostic, severity: "error" });
	}

	warn(diagnostics: readonly Diagnostic[]): void {
		for (const diagnostic of diagnostics) this.warnings.push({ ...diagnostic, severity: "warning" });
	}

	/** 捕获单个文档解析抛出的错误并记入集合；返回 undefined 表示该文档被跳过。 */
	collect<T>(parse: () => T): T | undefined {
		try {
			return parse();
		} catch (error) {
			if (error instanceof SuimError) {
				this.report(error.code, error.diagnostics.length > 0 ? error.diagnostics : [{ message: error.message }]);
				return undefined;
			}
			throw error;
		}
	}

	throwIfFailed(label: string): void {
		if (!this.failed) return;
		const first = this.errors[0];
		const summary =
			this.errors.length === 1
				? (first?.message ?? label)
				: `共 ${this.errors.length} 处问题，第一处：${first?.message ?? label}`;
		throw new BookParseError(this.#firstCode ?? "invalid_document", `${label}：${summary}`, this.errors);
	}
}
