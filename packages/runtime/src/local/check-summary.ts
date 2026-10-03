import { type Diagnostic, diagnosticDetail, formatDiagnostic } from "@suiming/story";
import { checkFindings } from "../artifact/story-design-validator.js";
import type { LocalProjectCheck } from "./local-project-service.js";

/**
 * 一条确定性诊断：`message` 是 formatDiagnostic 拼好的整句（位置、应为 / 实际、提示都在里面），
 * 单独出现时（CLI、host、错误提示）用它；位置与 `detail` 另给一份，供界面按文件归类后不再逐行重复路径。
 * CLI 的 check 结果、失败信封与桌面用同一个形状。
 */
export interface CheckDiagnostic {
	severity: "error" | "warning";
	path?: string;
	/** 行列只有文本级错误（如 YAML 解析）才有；字段级问题给 JSON pointer，多半落在 frontmatter。 */
	line?: number;
	column?: number;
	pointer?: string;
	/** 不含位置与严重程度的那半句。 */
	detail: string;
	message: string;
}

export function checkDiagnostic(diagnostic: Diagnostic): CheckDiagnostic {
	return {
		severity: diagnostic.severity === "warning" ? "warning" : "error",
		...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
		...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
		...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
		...(diagnostic.pointer === undefined ? {} : { pointer: diagnostic.pointer }),
		detail: diagnosticDetail(diagnostic),
		message: formatDiagnostic(diagnostic),
	};
}

/** 确定性检查的结构化结果。CLI 与桌面共用，文案由各自的界面决定，runtime 不拼句子。 */
export interface CheckSummary {
	/**
	 * 没有要修的问题（判定是 checkFindings，与 Agent 的 check 工具同一个）。**不是「能不能提交」**：
	 * 会被提交拒绝的问题让 check 直接失败，到不了这里；这里为 false 时仍可以阶段提交，diagnostics
	 * 里的错误要修或向作者说明。`missing_text` 只表示全书还没写完，不让它变 false；要判断「全书正文
	 * 是否齐了」看 `storyTextPassed`。
	 */
	passed: boolean;
	changedFiles: number;
	designPassed: boolean;
	statePassed: boolean;
	storyTextPassed: boolean;
	/** storyTextPassed 为 false 的原因；missing_text 只表示全书尚未写完，不是已有正文的错误。 */
	storyTextFailures: { storyBeatId: string; code: string; message: string }[];
	sourceCount: number;
	/**
	 * designPassed 为 false 的原因，以及不阻塞提交的警告；Source 抽取的诊断也在这里（路径在 source/<id>/ 下）。
	 * 2026-10-02 之前只有三个布尔：host 看得到「没过」却看不到哪里没过，只有 Suiming 自己的 Agent（formatCheck）看得到。
	 */
	diagnostics: CheckDiagnostic[];
}

/**
 * 曾经只有 CLI 拿得到这些字段：桌面的 `workspace.check` 在 runtime 里拼一句中文再返给界面，
 * 结构化结果被吞掉，作者看不出是哪一项没过——桌面是核心产品，却比 CLI 知道得少。
 */
export function checkSummary(checked: LocalProjectCheck): CheckSummary {
	const designPassed = checked.inspection.check.passed;
	const statePassed = checked.inspection.check.state.passed;
	const storyTextPassed = checked.inspection.storyText.passed;
	const findings = checkFindings(checked.inspection);
	return {
		passed: statePassed && findings.errors.length === 0 && findings.textFailures.length === 0,
		changedFiles: checked.diff.entries.length,
		designPassed,
		statePassed,
		storyTextPassed,
		storyTextFailures: checked.inspection.storyText.failures.map((failure) => ({
			storyBeatId: failure.storyBeatId,
			code: failure.code,
			message: failure.message,
		})),
		sourceCount: checked.inspection.sources.length,
		diagnostics: [
			...checked.inspection.check.diagnostics,
			...checked.inspection.check.warnings,
			...checked.inspection.sources.flatMap((source) =>
				source.check === undefined ? [] : [...source.check.diagnostics, ...source.check.warnings],
			),
		].map(checkDiagnostic),
	};
}
