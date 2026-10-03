import type { LocalCommandOutput } from "@suiming/sdk";
import { CommandError } from "./command-error.js";
import type { WorkspaceData } from "./model.js";

export type CheckResult = LocalCommandOutput<"project.check">;
export type CheckDiagnostic = CheckResult["diagnostics"][number];

/**
 * 一次检查的快照。检查要读整份候选（斗破 29 个 Beat 约半秒），不随每 100ms 的作品刷新重跑，
 * 所以带上检查时的候选指纹，作品之后有改动时界面能说「结果可能已过期」，而不是静默显示旧结论。
 */
export interface CheckOutcome {
	at: number;
	revisionId: string;
	dirtyFiles: number;
	basis: string;
	result?: CheckResult;
	/** 作品还不能绑定成设计，检查没有跑完：message 是「共 N 处，第一处」的汇总，诊断是全部问题。 */
	failure?: { message: string; diagnostics: CheckDiagnostic[] };
}

/**
 * 候选指纹：已提交版本、文件集合与未提交文件的长度。改动后码点数恰好不变的编辑会漏判——
 * 这只是过期提示，检查时间一直显示，「重新检查」一直可用。
 */
export function candidateBasis(data: Pick<WorkspaceData, "revisionId" | "files">): string {
	return [
		data.revisionId,
		...data.files.map((file) => (file.dirty ? `${file.path}*${file.codePoints}` : file.path)).sort(),
	].join("\n");
}

export async function runCheck(
	data: Pick<WorkspaceData, "revisionId" | "files">,
	check: () => Promise<CheckResult>,
	now = Date.now(),
): Promise<CheckOutcome> {
	const snapshot = {
		at: now,
		revisionId: data.revisionId,
		dirtyFiles: data.files.filter((file) => file.dirty).length,
		basis: candidateBasis(data),
	};
	try {
		return { ...snapshot, result: await check() };
	} catch (error) {
		// 绑定期失败也是检查的答案（「不能，问题在这些地方」），不是操作失败；没有诊断的才往上抛。
		if (error instanceof CommandError && error.diagnostics.length > 0)
			return { ...snapshot, failure: { message: error.message, diagnostics: error.diagnostics } };
		throw error;
	}
}

export interface DiagnosticGroup {
	path?: string;
	errors: number;
	warnings: number;
	items: CheckDiagnostic[];
}

/** 按文件归类：有错误的文件在前，组内错误在前；没有路径的单独一组放最后。 */
export function groupDiagnostics(diagnostics: readonly CheckDiagnostic[]): DiagnosticGroup[] {
	const groups = new Map<string | undefined, DiagnosticGroup>();
	for (const item of diagnostics) {
		const group = groups.get(item.path) ?? {
			...(item.path === undefined ? {} : { path: item.path }),
			errors: 0,
			warnings: 0,
			items: [],
		};
		if (item.severity === "error") group.errors += 1;
		else group.warnings += 1;
		group.items.push(item);
		groups.set(item.path, group);
	}
	const rank = (severity: CheckDiagnostic["severity"]) => (severity === "error" ? 0 : 1);
	return [...groups.values()]
		.map((group) => ({ ...group, items: group.items.toSorted((a, b) => rank(a.severity) - rank(b.severity)) }))
		.toSorted(
			(a, b) =>
				Number(a.path === undefined) - Number(b.path === undefined) ||
				Number(a.errors === 0) - Number(b.errors === 0) ||
				(a.path ?? "").localeCompare(b.path ?? ""),
		);
}

/** 文件内位置：行列与 JSON pointer，二者都可能缺。 */
export function diagnosticPosition(item: CheckDiagnostic): string {
	const line = item.line === undefined ? "" : `${item.line}${item.column === undefined ? "" : `:${item.column}`}`;
	return [line, item.pointer ?? ""].filter(Boolean).join(" ");
}

export function blockingTextFailures(result: CheckResult) {
	return result.storyTextFailures.filter((failure) => failure.code !== "missing_text");
}

/** 检查按钮的一句话结果；`details` 为 true 时提示里带「查看详情」打开检查结果页。 */
export function checkNotice(outcome: CheckOutcome): { text: string; tone: "ok" | "warn"; details: boolean } {
	if (outcome.failure)
		return {
			text: `作品文件有结构问题，检查没有跑完：共 ${outcome.failure.diagnostics.length} 处。`,
			tone: "warn",
			details: true,
		};
	const result = outcome.result;
	if (!result) return { text: "检查没有结果。", tone: "warn", details: false };
	const errors = result.diagnostics.filter((item) => item.severity === "error").length;
	const warnings = result.diagnostics.length - errors;
	const counts = [errors ? `${errors} 处错误` : "", warnings ? `${warnings} 条警告` : ""].filter(Boolean);
	if (result.passed)
		return {
			text: `检查通过${result.changedFiles ? `；${result.changedFiles} 个文件未提交` : ""}${counts.length ? `；${counts.join("、")}` : ""}。`,
			tone: "ok",
			details: result.diagnostics.length > 0,
		};
	const blocking = blockingTextFailures(result);
	const failed = [
		result.designPassed ? undefined : "设计",
		result.statePassed ? undefined : "硬状态",
		blocking.length === 0 ? undefined : "正文",
	].filter((name): name is string => name !== undefined);
	return {
		text: `检查未通过：${failed.join(" / ")}${counts.length ? `；${counts.join("、")}` : ""}${blocking.length ? `；${blocking.length} 篇正文有问题` : ""}。`,
		tone: "warn",
		details: true,
	};
}
