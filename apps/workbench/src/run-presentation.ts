import type { LocalCommandOutput, SuimingTurnSummary } from "@suiming/sdk";

export type SessionSummary = LocalCommandOutput<"session.list">["sessions"][number];
export const sessionStatusLabels: Record<string, string> = {
	running: "正在处理",
	idle: "等你继续",
};
export const isSessionActive = (session: { status: string } | undefined) => session?.status === "running";

/** 操作由 Runtime 错误码决定；原始原因保留在详情中，不用文案猜测恢复策略。 */
export function sessionProblem(session: SessionSummary) {
	const failure = session.lastFailure;
	if (!failure) return undefined;
	const code = failure.code;
	const known: Record<string, { title: string; hint: string }> = {
		run_no_progress: {
			title: "需要调整方向",
			hint: "模型在原地打转：同一个动作反复得到同一个结果，或接连做了被拒绝的动作。进度已保存，在输入框补充要求后继续。",
		},
		turn_usage_checkpoint: {
			title: "到了这一轮的用量检查点",
			hint: "进度与子任务都已保存。发一条消息（比如「继续」）就从原处接着做。",
		},
		process_restart: { title: "上次没有正常结束", hint: "进度已保存，发一条消息即可继续。" },
		model_provider_disabled: { title: "提供商已停用", hint: "在设置中启用此提供商，或选择其他模型。已有凭据保留。" },
		model_credentials_missing: { title: "提供商连接不可用", hint: "从输入框的模型菜单打开设置，重新连接提供商。" },
		model_not_found: { title: "当前模型不可用", hint: "从输入框的模型菜单选择可用模型后继续。" },
		model_call_failed: { title: "模型调用失败", hint: "查看原因；再发一条消息即可重试。" },
	};
	return {
		...(known[code] ?? { title: "这一轮没有正常结束", hint: "查看原因后继续，已保存的结果与提交都会保留。" }),
		detail: failure.message,
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
	// 作者停下的 turn 总要说一声，哪怕什么都没改：否则对话里只剩一串操作、后面没有回复。
	if (total === 0 && summary.revisions === 0) return summary.stopped ? "已停止" : undefined;
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
	return `${summary.stopped ? "已停止 · " : ""}本轮：${parts.join(" · ")}`;
}

type TranscriptRow =
	| { kind: "message" | "summary"; id: string; sequence: number }
	| { kind: "activity"; id: string; sequence: number; activity: { taskId?: string | undefined } };
type ActivityOf<R> = R extends { kind: "activity"; activity: infer A } ? A : never;
type ActivityGroup<R> = { kind: "activities"; taskId?: string; rows: ActivityOf<R>[] };
export type TranscriptGroup<R> = Exclude<R, { kind: "activity" }> | ActivityGroup<R>;

/**
 * 对话按时间排好之后成组：消息与 turn 摘要各自一行；相邻的动作按执行者并成一组——根 Agent 的一组，
 * 每个子任务各一组（taskId 是子任务的 id，根 Agent 的动作 taskId 就是 sessionId，旧事件没有 taskId 也算根）。
 * 2026-10-02 之前不分执行者连成一组，委派一节正文就显示「已执行 30 项操作」，根 Agent 自己只做了两三件。
 */
export function transcriptGroups<R extends TranscriptRow>(rows: readonly R[], sessionId: string): TranscriptGroup<R>[] {
	const groups: TranscriptGroup<R>[] = [];
	// 一段从上一条消息或根 Agent 的动作之后开始。并行的子任务动作在事件流里交错到达，同一段里按子任务归组，
	// 不在每次换任务时断开；根 Agent 的动作仍是时间上的分界，不往前并。
	let span = 0;
	for (const row of [...rows].sort((a, b) => a.sequence - b.sequence)) {
		if (row.kind !== "activity") {
			groups.push(row as Exclude<R, { kind: "activity" }>);
			span = groups.length;
			continue;
		}
		const activity = (row as Extract<R, { kind: "activity" }>).activity as ActivityOf<R>;
		const owner = (activity as { taskId?: string | undefined }).taskId;
		const taskId = owner && owner !== sessionId ? owner : undefined;
		const previous = groups.at(-1);
		if (taskId === undefined) {
			if (previous?.kind === "activities" && previous.taskId === undefined) previous.rows.push(activity);
			else groups.push({ kind: "activities", rows: [activity] });
			span = groups.length;
			continue;
		}
		const same = groups.slice(span).find((group) => group.kind === "activities" && group.taskId === taskId) as
			| ActivityGroup<R>
			| undefined;
		if (same) same.rows.push(activity);
		else groups.push({ kind: "activities", taskId, rows: [activity] });
	}
	return groups;
}

/**
 * 组里连续的同类动作并成一行（读了 12 个文件是一行「读取文件 12 次」，展开再看每一个）。只并相邻的：
 * 动作之间的先后有意义（读完再写、写完再检查），不按种类重排。
 */
export function actionRuns<A extends { label: string; status: string }>(
	rows: readonly A[],
	/** 按什么算同类：界面上按显示的名字，write 与 edit 都显示「修改文件」，就并在一起。 */
	kind: (row: A) => string = (row) => row.label,
): { label: string; rows: A[]; failed: number }[] {
	const runs: { label: string; rows: A[]; failed: number }[] = [];
	for (const row of rows) {
		const previous = runs.at(-1);
		const label = kind(row);
		const run = previous?.label === label ? previous : { label, rows: [], failed: 0 };
		if (run !== previous) runs.push(run);
		run.rows.push(row);
		if (row.status === "failed") run.failed += 1;
	}
	return runs;
}

/**
 * 子任务那一行已经代表了建它的那次委派或审稿，根 Agent 里那一行就不再单独列：点开子任务那一行，先看到的就是
 * 委派的内容与交回的结果。只收起对话里确实有子任务那一行的；子任务一个动作都没做就失败了（开场就放不下），
 * 委派那一行照常显示，否则这件事在对话里就看不见了。
 */
export function delegatingActions(
	groups: readonly { kind: string; taskId?: string }[],
	tasks: readonly { id: string; key: string }[],
): Set<string> {
	const shown = new Set(
		groups.flatMap((group) => (group.kind === "activities" && group.taskId ? [group.taskId] : [])),
	);
	return new Set(tasks.filter((task) => shown.has(task.id)).map((task) => task.key));
}

export interface DetailField {
	name: string;
	value: string;
	/** 单独成块（长文本、多行、长 JSON），否则一行「名：值」。 */
	block: boolean;
}

/**
 * 点开动作时参数（或 JSON 结果）怎么摆：逐项「名：值」，嵌套的对象展开成「外.内」；字符串保留换行，长的或多行的
 * 单独成块；其余值写成 JSON，短的一行，长的成块并缩进。斗破走查里 `span: [205294, 256503]` 被拆成四行大块，
 * 委派交回的报告在 JSON 里换行全成了 \n。
 */
export function detailFields(value: Record<string, unknown>, prefix = "", depth = 0): DetailField[] {
	return Object.entries(value).flatMap(([key, item]): DetailField[] => {
		const name = prefix ? `${prefix}.${key}` : key;
		if (item !== null && typeof item === "object" && !Array.isArray(item) && depth < 2)
			return detailFields(item as Record<string, unknown>, name, depth + 1);
		if (typeof item === "string")
			return [{ name, value: item, block: item.includes("\n") || Array.from(item).length > 80 }];
		const compact = JSON.stringify(item) ?? String(item);
		return Array.from(compact).length > 80
			? [{ name, value: JSON.stringify(item, null, 2), block: true }]
			: [{ name, value: compact, block: false }];
	});
}

/** 工具结果：JSON 对象按字段列（作品状态、提交、委派的交回），JSON 数组排成缩进，其余原样。 */
export function outputView(output: string): { fields: DetailField[] } | { text: string } {
	const trimmed = output.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
				return { fields: detailFields(parsed as Record<string, unknown>) };
			return { text: JSON.stringify(parsed, null, 2) };
		} catch {
			// 不是 JSON，原样显示
		}
	}
	return { text: output };
}

/** 内部编号（执行对象、子任务、动作的 id）不给作者看；动作的对象是它们时不显示。 */
export const internalId = (value: string) => /^(?:eo|task|action|call|session)_[0-9a-f]/u.test(value);

type TaskRole = LocalCommandOutput<"models.show">["profiles"][number]["id"];
/**
 * 子任务按角色（它绑定的模型档位）显示的中文名，与设置页的档位名一致（Runtime 的 MODEL_PROFILE_LABELS）；
 * main 是通用委派，就叫「子任务」。按 sdk 的档位类型写成 Record，新增档位时这里编译不过。
 */
const TASK_ROLE_LABELS: Record<TaskRole, string> = {
	main: "子任务",
	writer: "正文写作",
	reviewer: "独立审稿",
	"source-reader": "原作阅读",
	"source-extractor": "原作抽取",
	judge: "评委",
};
/** 2026-10-05 之前的记录按建它的入口记 kind（subagent 说的是类别本身）。 */
const LEGACY_TASK_KINDS: Record<string, string> = { subagent: "子任务", review: "独立审稿", "rank.round": "评委" };

/** 子任务的中文名；子任务列表与对话里子任务的动作组共用。 */
export const taskRoleLabel = (kind: string | undefined) =>
	kind === undefined
		? "子任务"
		: ((TASK_ROLE_LABELS as Record<string, string>)[kind] ?? LEGACY_TASK_KINDS[kind] ?? kind);

/** 作者消息里接在原话后面的引用与附件（composerText 拼的），开头是这几种固定前缀之一。 */
const REFERENCE_PREFIXES = ["作品引用：", "对话引用：", "外部文本附件："];

export interface MessageReference {
	/** 给作者看的一行：作品引用用标题与选段位置，附件用文件名。 */
	label: string;
	/** 原样的引用内容，发给 Agent 的就是它。 */
	content: string;
	/** 展开时给作者看的：引用的那段文字本身，不带版本与内容 SHA 这类定位信息。 */
	quote: string;
}

/**
 * 把作者消息拆成原话与引用。发给 Agent 的仍是整段文本（定位要靠版本与内容 SHA），对话里只把原话当消息显示，
 * 引用折成可展开的标签：2026-10-05 之前选段修改的消息气泡里摊着 revision 与 contentSHA 两串哈希。
 * titleOf 把作品路径换成标题，认不出的路径原样用。
 */
export function messageReferences(
	text: string,
	titleOf: (path: string) => string | undefined,
): { body: string; references: MessageReference[] } {
	const starts = text.startsWith("\n") ? [] : [0];
	const blocks: number[] = [];
	for (const start of [...starts, ...[...text.matchAll(/\n\n/gu)].map((match) => (match.index ?? 0) + 2)])
		if (REFERENCE_PREFIXES.some((prefix) => text.startsWith(prefix, start))) blocks.push(start);
	if (blocks.length === 0) return { body: text, references: [] };
	const references = blocks.map((start, index) => {
		const next = blocks[index + 1];
		const content = text.slice(start, next === undefined ? undefined : next - 2).trimEnd();
		const [first = "", ...rest] = content.split("\n");
		const prefix = REFERENCE_PREFIXES.find((item) => first.startsWith(item)) ?? "";
		const target = first.slice(prefix.length).trim();
		if (prefix === "作品引用：") {
			const marker = rest.findIndex((line) => /^(第 \d+ 段选段|选段|文件内容)：$/u.test(line));
			const part = marker < 0 ? undefined : rest[marker]?.slice(0, -1);
			const name = titleOf(target) ?? target;
			return {
				label: part && part !== "文件内容" ? `${name} · ${part}` : name,
				content,
				quote: marker < 0 ? target : rest.slice(marker + 1).join("\n"),
			};
		}
		// 对话引用与外部附件：头一段是来源说明，空行之后才是内容。
		const gap = content.indexOf("\n\n");
		return {
			label: prefix === "对话引用：" ? "对话引用" : target,
			content,
			quote: gap < 0 ? content : content.slice(gap + 2),
		};
	});
	return { body: text.slice(0, blocks[0]).trimEnd(), references };
}
