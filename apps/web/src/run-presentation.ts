import type { LocalCommandOutput, SuimingTurnSummary } from "@suiming/sdk";

export type SessionSummary = LocalCommandOutput<"session.list">["sessions"][number];
export const sessionStatusLabels: Record<string, string> = {
	running: "正在处理",
	idle: "等你继续",
	paused: "需要处理",
};
export const isSessionActive = (session: { status: string } | undefined) => session?.status === "running";

/** 操作由 Runtime 错误码决定；原始原因保留在详情中，不用文案猜测恢复策略。 */
export function sessionProblem(session: SessionSummary) {
	const failure = session.pause ?? session.lastFailure;
	if (!failure) return undefined;
	const code = failure.code;
	const known: Record<string, { title: string; hint: string }> = {
		model_call_unknown: {
			title: "模型请求结果待确认",
			hint: "上次请求可能已经产生用量。确认后可重新请求，已保存的工具结果不会重复执行。",
		},
		action_effect_unknown: { title: "有一个动作停在半途", hint: "查看原因后继续，已保存的结果不会重复执行。" },
		binding_mismatch: { title: "模型或工具面已变化", hint: "换回原来的模型继续，或停止后再换。" },
		run_no_progress: { title: "需要调整方向", hint: "模型重复了相同的无效动作。在输入框补充要求后继续。" },
		process_restart: { title: "上次没有正常结束", hint: "进度已保存，发一条消息即可继续。" },
		model_provider_disabled: { title: "提供商已停用", hint: "在设置中启用此提供商，或选择其他模型。已有凭据保留。" },
		model_credentials_missing: { title: "提供商连接不可用", hint: "从输入框的模型菜单打开设置，重新连接提供商。" },
		model_not_found: { title: "当前模型不可用", hint: "从输入框的模型菜单选择可用模型后继续。" },
		model_call_failed: { title: "模型调用失败", hint: "查看原因；再发一条消息即可重试。" },
	};
	return {
		...(known[code] ?? { title: "这一轮没有正常结束", hint: "查看原因后继续，已保存的结果与提交都会保留。" }),
		detail: failure.message,
		paused: session.status === "paused",
		unknownModelCall: code === "model_call_unknown",
	};
}

/**
 * turn 结束对账的一行字（事件 `suiming.turn`）。只摆事实不下判断：作者几条、意图改没改、各类改了几个、
 * 提交了几个版本、还剩几个没提交。这一轮既没改作品也没提交就不显示——只讨论的 turn 不该多一行噪声，
 * checkout 里未提交的候选另有入口。「意图未改动」只在有改动时出现：它就是要让作者看见的那个信号。
 */
export function turnSummaryText(summary: SuimingTurnSummary): string | undefined {
	const { changed } = summary;
	const total =
		changed.intent.count + changed.design.count + changed.text.count + changed.review.count + changed.other.count;
	if (total === 0 && summary.revisions === 0) return undefined;
	const parts: string[] = [];
	if (summary.authorMessages > 0) parts.push(`作者 ${summary.authorMessages} 条`);
	parts.push(changed.intent.count === 0 ? "意图未改动" : `意图改了 ${changed.intent.count} 个文件`);
	// 没取写作依据就整篇写入的正文跟在正文后面说：写作方法与硬边界只跟着 Write Context 到
	const uninformed = summary.textWithoutContext?.count ?? 0;
	for (const [label, item] of [
		["设计", changed.design],
		["正文", changed.text],
		["审稿", changed.review],
		["其它", changed.other],
	] as const)
		if (item.count > 0)
			parts.push(
				`${label}改了 ${item.count} 个文件${label === "正文" && uninformed > 0 ? `，其中 ${uninformed} 个没先读取写作依据` : ""}`,
			);
	parts.push(summary.revisions === 0 ? "没有提交" : `提交了 ${summary.revisions} 个版本`);
	if (summary.uncommitted > 0) parts.push(`还有 ${summary.uncommitted} 个文件未提交`);
	return `本轮：${parts.join(" · ")}`;
}

type TranscriptRow =
	| { kind: "message" | "summary"; id: string; sequence: number }
	| { kind: "activity"; id: string; sequence: number; activity: { taskId?: string | undefined } };
type ActivityOf<R> = R extends { kind: "activity"; activity: infer A } ? A : never;
export type TranscriptGroup<R> =
	| Exclude<R, { kind: "activity" }>
	| { kind: "activities"; taskId?: string; rows: ActivityOf<R>[] };

/**
 * 对话按时间排好之后成组：消息与 turn 摘要各自一行；相邻的动作按执行者并成一组——根 Agent 的一组，
 * 每个子任务各一组（taskId 是子任务的 id，根 Agent 的动作 taskId 就是 sessionId，旧事件没有 taskId 也算根）。
 * 2026-10-02 之前不分执行者连成一组，委派一节正文就显示「已执行 30 项操作」，根 Agent 自己只做了两三件。
 */
export function transcriptGroups<R extends TranscriptRow>(rows: readonly R[], sessionId: string): TranscriptGroup<R>[] {
	const groups: TranscriptGroup<R>[] = [];
	for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
		if (row.kind !== "activity") {
			groups.push(row as Exclude<R, { kind: "activity" }>);
			continue;
		}
		const activity = (row as Extract<R, { kind: "activity" }>).activity as ActivityOf<R>;
		const owner = (activity as { taskId?: string | undefined }).taskId;
		const taskId = owner && owner !== sessionId ? owner : undefined;
		const previous = groups.at(-1);
		if (previous?.kind === "activities" && previous.taskId === taskId) previous.rows.push(activity);
		else groups.push({ kind: "activities", ...(taskId === undefined ? {} : { taskId }), rows: [activity] });
	}
	return groups;
}

/** 子任务的中文名；子任务列表与对话里子任务的动作组共用。 */
export const taskKindLabel = (kind: string | undefined) =>
	kind === "review" ? "独立审稿" : kind === "subagent" || kind === undefined ? "子任务" : kind;
