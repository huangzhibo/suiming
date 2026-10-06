import type { SessionEvent, SuimingTurnSummary } from "@suiming/sdk";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Quote } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { invoke } from "./bridge.js";
import { Markdown } from "./markdown.js";
import {
	actionRuns,
	type DetailField,
	delegatingActions,
	detailFields,
	internalId,
	messageReferences,
	outputView,
	taskRoleLabel,
	transcriptGroups,
	turnSummaryText,
} from "./run-presentation.js";
import { Hint } from "./ui-bits.js";
import { useConversation } from "./use-conversation.js";

function MessageActions({ text, onReference }: { text: string; onReference(): void }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState("");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<div className="message-actions flex min-h-6 items-center gap-1">
			<Hint content={copied ? "已复制" : "复制消息"}>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={copied ? "已复制" : "复制消息"}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(text);
							setCopied(true);
							setError("");
							clearTimeout(timer.current);
							timer.current = setTimeout(() => setCopied(false), 1800);
						} catch {
							setError("复制失败，请选中文字后复制。");
						}
					}}
				>
					{copied ? <Check /> : <Copy />}
				</Button>
			</Hint>
			<Hint content="引用消息">
				<Button type="button" size="icon-xs" variant="ghost" aria-label="引用消息" onClick={onReference}>
					<Quote />
				</Button>
			</Hint>
			{error && (
				<span role="alert" className="text-xs text-destructive">
					{error}
				</span>
			)}
		</div>
	);
}
const actionLabels: Record<string, string> = {
	read: "读取文件",
	project_status: "核对作品状态",
	write: "修改文件",
	edit: "修改文件",
	list: "浏览目录",
	search: "检索作品",
	commit: "提交作品",
	delete: "删除文件",
	check: "检查作品",
	frame: "查看硬状态",
	compact_context: "整理上下文",
	review: "独立审稿",
	write_context: "读取写作依据",
	delegate: "派出子任务",
	resume_task: "续做子任务",
	// 2026-10-05 删掉的工具，旧对话的动作记录里还有
	read_result: "读取子任务结果",
	read_source: "读原作",
	source_coverage: "查看原作读到哪里",
	story_guide: "查格式说明",
	read_material: "读材料",
	search_material: "检索材料",
	search_source: "检索原作",
	impact: "查看改动影响",
	copy: "复制文件",
	move: "移动文件",
	submit_ranking: "交回排名",
	submit_task: "交回子任务结果",
	submit_review: "交回审稿",
};
type Activity = {
	id: string;
	sequence: number;
	/** 执行这个动作的子任务（事件上的 subagentRunId）；根 Agent 的没有，2026-10-05 之前的事件是 sessionId。 */
	taskId?: string;
	label: string;
	status: string;
	target?: string;
	summary?: string;
};
/**
 * 活动的 target 可能是路径、Beat id、检索词或结果 id；只有真实作品路径才做成可打开的链接，显示作品标题，
 * 路径放进提示。2026-10-05 之前显示路径，作者看到一列 outline/story/vol-0009/beat-0440.md，认不出是哪一节。
 */
function ActivityTarget({
	target,
	titles,
	open,
}: {
	target: string | undefined;
	titles: ReadonlyMap<string, string>;
	open(path: string): void;
}) {
	if (!target) return null;
	const title = titles.get(target);
	if (title === undefined) return <>{target}</>;
	return (
		<Hint content={target}>
			<button
				type="button"
				className="underline underline-offset-2 hover:text-foreground"
				data-page={target}
				onClick={(event) => {
					// summary 自己会切换 details，打开作品不应顺带折叠这条活动。
					event.preventDefault();
					event.stopPropagation();
					open(target);
				}}
			>
				{title || target}
			</button>
		</Hint>
	);
}

/**
 * 作者消息：原话照常显示，接在后面的作品引用与附件折成可展开的标签（messageReferences）。复制、引用与导出仍用整段原文，
 * 发给 Agent 的也是整段：定位要靠里面的版本与内容 SHA，只是不该摊在作者自己的气泡里。
 */
function UserMessage({
	text,
	titles,
	links,
}: {
	text: string;
	titles: ReadonlyMap<string, string>;
	links: ReadonlyMap<string, () => void>;
}) {
	const { body, references } = messageReferences(text, (path) => titles.get(path));
	return (
		<>
			{body && <Markdown className="msg-text rounded-xl bg-muted px-3 py-2" content={body} links={links} />}
			{references.map((reference) => (
				<details key={reference.content} className="message-reference mt-1.5 text-xs text-muted-foreground">
					<summary className="ml-auto block w-fit max-w-full cursor-pointer list-none truncate rounded-md border px-2 py-1 [&::-webkit-details-marker]:hidden">
						{reference.label}
					</summary>
					<pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted px-2 py-1.5 font-sans whitespace-pre-wrap">
						{reference.quote}
					</pre>
				</details>
			))}
		</>
	);
}

/** 子任务停在哪儿；完成的不另外说。 */
const TASK_STATUS_TEXT: Record<string, string> = { running: "进行中", failed: "没有完成", interrupted: "已停下" };

/**
 * 点开一个动作看到的完整输入与输出，从跑它的 loop 的执行记录里按需读（`session.action`）：事件里只有一句摘要，
 * 不为它在事件流里再存一份。revision 变了就重读——子任务那一行里的委派，子任务做完之前还没有交回的结果。
 */
function ActionDetail({
	sessionId,
	taskId,
	actionId,
	revision,
}: {
	sessionId: string;
	/** 跑这个动作的子任务；根 Agent 的动作不给。 */
	taskId: string | undefined;
	actionId: string;
	revision: string;
}) {
	const query = useQuery({
		queryKey: ["action", sessionId, taskId ?? "", actionId, revision],
		queryFn: () => invoke("session.action", { sessionId, actionId, ...(taskId === undefined ? {} : { taskId }) }),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	if (query.isPending) return <p className="action-detail mt-1">正在读取…</p>;
	if (query.isError)
		return (
			<p className="action-detail mt-1">
				{query.error instanceof Error ? query.error.message : String(query.error)}
			</p>
		);
	const detail = query.data;
	const output = detail.output === undefined ? undefined : outputView(detail.output);
	return (
		<div className="action-detail mt-1.5 grid gap-1.5 text-foreground/80">
			<DetailFields fields={detailFields(detail.input)} />
			<div className="grid gap-1.5">
				<p className="text-muted-foreground">结果</p>
				{output === undefined ? (
					<p>还没交回。</p>
				) : "fields" in output ? (
					<DetailFields fields={output.fields} error={detail.isError} />
				) : (
					<pre className={`${DETAIL_BLOCK} ${detail.isError ? "text-destructive" : ""}`}>
						{output.text || "（没有输出）"}
					</pre>
				)}
				{detail.truncated && <p className="text-muted-foreground">结果太长，只显示前 10 万字。</p>}
			</div>
		</div>
	);
}

const DETAIL_BLOCK = "max-h-60 overflow-auto rounded-md bg-muted px-2 py-1.5 font-sans whitespace-pre-wrap break-words";

/** 参数或 JSON 结果的各项：短的一行「名：值」，长的单独成块。 */
function DetailFields({ fields, error = false }: { fields: DetailField[]; error?: boolean }) {
	return fields.map((field) =>
		field.block ? (
			<div key={field.name}>
				<p className="text-muted-foreground">{field.name}</p>
				<pre className={`mt-0.5 ${DETAIL_BLOCK} ${error ? "text-destructive" : ""}`}>{field.value}</pre>
			</div>
		) : (
			<p key={field.name} className={`break-words ${error ? "text-destructive" : ""}`}>
				<span className="text-muted-foreground">{field.name}：</span>
				{field.value}
			</p>
		),
	);
}

/** 一个动作一行「名称 · 对象」，点开看完整输入与输出；失败的默认展开。 */
function ActionRow({
	sessionId,
	taskId,
	activity,
	titles,
	open,
	compact = false,
}: {
	sessionId: string;
	taskId: string | undefined;
	activity: Activity;
	titles: ReadonlyMap<string, string>;
	open(path: string): void;
	/** 在「修改文件 24 次」这样的行里：动作名已经在上面，只写对象。 */
	compact?: boolean;
}) {
	const [expanded, setExpanded] = useState(activity.status === "failed");
	const label = actionLabels[activity.label] ?? activity.label;
	// 内部编号（执行对象、子任务的 id）不给作者看，2026-10-05 之前的 read_result 就以它为对象。
	const target = activity.target && !internalId(activity.target) ? activity.target : undefined;
	return (
		<details
			className="activity leading-relaxed"
			data-action-id={activity.id}
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="shrink-0" />
				<span className="min-w-0 flex-1 truncate">
					{compact && target ? null : label}
					{target && !compact ? " · " : ""}
					<ActivityTarget target={target} titles={titles} open={open} />
				</span>
				{/* 动作只在结束时发出（suiming.action 只有 completed / failed）；成功的不另外标。 */}
				{activity.status === "failed" && <span className="shrink-0 text-destructive">失败</span>}
			</summary>
			{expanded && (
				<div className="ml-4">
					<ActionDetail sessionId={sessionId} taskId={taskId} actionId={activity.id} revision={activity.status} />
				</div>
			)}
		</details>
	);
}

/** 连续的同类动作：一行「读取文件 12 次」，展开是每一个，再点开看各自的输入与输出；有失败的默认展开。 */
function ActionRun({
	sessionId,
	taskId,
	run,
	titles,
	open,
}: {
	sessionId: string;
	taskId: string | undefined;
	run: { label: string; rows: Activity[]; failed: number };
	titles: ReadonlyMap<string, string>;
	open(path: string): void;
}) {
	const [expanded, setExpanded] = useState(run.failed > 0);
	return (
		<details
			className="activity-run leading-relaxed"
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="shrink-0" />
				{run.label} {run.rows.length} 次{run.failed ? `，${run.failed} 次失败` : ""}
			</summary>
			{expanded && (
				<div className="mt-1 ml-4 grid gap-1">
					{run.rows.map((activity) => (
						<ActionRow
							key={activity.id}
							sessionId={sessionId}
							taskId={taskId}
							activity={activity}
							titles={titles}
							open={open}
							compact
						/>
					))}
				</div>
			)}
		</details>
	);
}

/** 一串动作：连续的同类动作并成一行（actionRuns），其余一个一行。 */
function ActionList({
	sessionId,
	taskId,
	rows,
	titles,
	open,
}: {
	sessionId: string;
	taskId: string | undefined;
	rows: Activity[];
	titles: ReadonlyMap<string, string>;
	open(path: string): void;
}) {
	return actionRuns(rows, (row) => actionLabels[row.label] ?? row.label).map((run) =>
		run.rows.length === 1 ? (
			<ActionRow
				key={run.rows[0]?.id}
				sessionId={sessionId}
				taskId={taskId}
				activity={run.rows[0] as Activity}
				titles={titles}
				open={open}
			/>
		) : (
			<ActionRun key={run.rows[0]?.id} sessionId={sessionId} taskId={taskId} run={run} titles={titles} open={open} />
		),
	);
}

/**
 * 子任务一行：「角色 · 它在做什么 · N 项操作」加失败数与状态（标题来自委派时给的 title，2026-10-06 之前的记录没有，
 * 只显示角色）。点开先是委派那一行——交给它的任务与它交回的结果，根 Agent 那边就不再单独列——再是它的每一步。
 * 收起时不挂里面的行：一轮抽取两千多个动作，全挂上是一万多个节点，切到对话就要渲染好几秒。「展开执行记录」时默认展开。
 */
function SubtaskGroup({
	sessionId,
	taskId,
	heading,
	status,
	delegation,
	rows,
	showLog,
	titles,
	open,
}: {
	sessionId: string;
	taskId: string;
	heading: string;
	status: string | undefined;
	/** 建这个子任务的那次委派或审稿（根 Agent 的动作）；子任务列表还没读到时没有。 */
	delegation: Activity | undefined;
	rows: Activity[];
	showLog: boolean;
	titles: ReadonlyMap<string, string>;
	open(path: string): void;
}) {
	const [expanded, setExpanded] = useState(showLog);
	useEffect(() => setExpanded(showLog), [showLog]);
	const failed = rows.filter((item) => item.status === "failed").length;
	const count = `${rows.length} 项操作${failed ? `，${failed} 项失败` : ""}`;
	const state = status === undefined ? undefined : TASK_STATUS_TEXT[status];
	return (
		<details
			className="activities text-xs text-muted-foreground"
			data-task-id={taskId}
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="shrink-0" />
				<span className="min-w-0 truncate">
					{heading} · {count}
					{state ? ` · ${state}` : ""}
				</span>
			</summary>
			{expanded && (
				<div className="mt-1 ml-4 grid gap-1">
					{delegation && (
						<ActionRow
							sessionId={sessionId}
							taskId={undefined}
							activity={delegation}
							titles={titles}
							open={open}
						/>
					)}
					<ActionList sessionId={sessionId} taskId={taskId} rows={rows} titles={titles} open={open} />
				</div>
			)}
		</details>
	);
}

type Row =
	| { kind: "message"; id: string; sequence: number; role: string; text: string }
	| { kind: "activity"; id: string; sequence: number; activity: Activity }
	| { kind: "summary"; id: string; sequence: number; text: string };

export function Transcript({
	sessionId,
	history = false,
	running = false,
	showLog,
	titles,
	open,
	onExport,
	onReference,
}: {
	sessionId: string;
	history?: boolean;
	/** 执行库里这个 session 正在跑；只有这时最后一条消息才按流式渲染。 */
	running?: boolean;
	showLog: boolean;
	/** 当前作品的全部文件路径与显示标题；Agent 提到其中之一时才渲染成可打开的链接。 */
	titles: ReadonlyMap<string, string>;
	open(path: string): void;
	onExport(sessionId: string, text: string): void;
	onReference(id: string, text: string): void;
}) {
	const links = useMemo(() => new Map([...titles.keys()].map((path) => [path, () => open(path)])), [titles, open]);
	// 事件只改这份记录，同一帧里到的合成一次重渲染。原来每个动作快照都 setState 复制整份记录：长对话 attach 时
	// 一次重放两千多个动作，复制是平方级的，加上逐个重渲染，主线程卡住四秒多（2026-10-06，斗破 120 章那次对话）。
	const store = useRef({
		activities: new Map<string, Activity>(),
		summaries: new Map<string, { sequence: number; summary: SuimingTurnSummary }>(),
		order: new Map<string, number>(),
	});
	const [, setVersion] = useState(0);
	const frame = useRef(0);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);
	const [connectionState, setConnectionState] = useState("loading");
	const onEvent = useCallback((record: SessionEvent) => {
		const event = record.event;
		const { activities, summaries, order } = store.current;
		if (event.type === "TEXT_MESSAGE_START") order.set(event.messageId, record.sequence);
		if (event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.turn")
			summaries.set(event.messageId, {
				sequence:
					summaries.get(event.messageId)?.sequence ?? Number(event.metadata?.suiming?.sequence ?? record.sequence),
				summary: event.content as SuimingTurnSummary,
			});
		if (event.type === "ACTIVITY_SNAPSHOT" && event.activityType === "suiming.action") {
			const body = event.content as {
				/** 2026-10-05 之前落盘的事件：执行者写在内容里（根 Agent 是 sessionId），现在是事件上的 subagentRunId。 */
				taskId?: string;
				label: string;
				status: string;
				target?: string;
				summary?: string;
			};
			activities.set(event.messageId, {
				...body,
				...(event.subagentRunId === undefined ? {} : { taskId: event.subagentRunId }),
				id: event.messageId,
				sequence:
					activities.get(event.messageId)?.sequence ??
					Number(event.metadata?.suiming?.sequence ?? record.sequence),
			});
		}
		if (!frame.current)
			frame.current = requestAnimationFrame(() => {
				frame.current = 0;
				setVersion((version) => version + 1);
			});
	}, []);
	const { messages, generating } = useConversation(sessionId, onEvent, setConnectionState, history);
	const rows: Row[] = messages.map((message) => ({
		kind: "message" as const,
		id: message.id,
		sequence: store.current.order.get(message.id) ?? message.sequence ?? 0,
		role: message.role,
		text: message.text,
	}));
	const latest = rows.at(-1)?.id;
	const exported = rows
		.map((row) => (row.kind === "message" ? `## ${row.role === "user" ? "作者" : "Suiming"}\n\n${row.text}` : ""))
		.join("\n\n");
	useEffect(() => {
		if (connectionState === "ready" && messages.length) onExport(sessionId, exported);
	}, [sessionId, exported, onExport, connectionState, messages.length]);
	rows.push(
		...[...store.current.activities.values()].map((activity) => ({
			kind: "activity" as const,
			id: activity.id,
			sequence: activity.sequence,
			activity,
		})),
	);
	for (const [id, { sequence, summary }] of store.current.summaries) {
		const text = turnSummaryText(summary);
		if (text) rows.push({ kind: "summary", id, sequence, text });
	}
	const groups = transcriptGroups(rows, sessionId);
	const tasks = useQuery({ queryKey: ["tasks", sessionId], queryFn: () => invoke("session.tasks", { sessionId }) });
	const taskOf = (taskId: string) => tasks.data?.find((task) => task.id === taskId);
	// 有子任务那一行的委派与审稿不在根 Agent 的动作里重复列，放进子任务那一行。
	const delegating = delegatingActions(groups, tasks.data ?? []);
	const delegationOf = (taskId: string): Activity | undefined => {
		const task = taskOf(taskId);
		if (task === undefined) return undefined;
		// 子任务还在跑时，委派那个动作还没交回、事件还没来。
		return (
			store.current.activities.get(task.key) ?? {
				id: task.key,
				sequence: 0,
				label: task.kind === "reviewer" ? "review" : "delegate",
				status: "running",
			}
		);
	};
	return (
		<div className="transcript flex flex-col gap-3">
			{connectionState === "loading" && !messages.length && (
				<p role="status" className="text-xs text-muted-foreground">
					正在读取对话…
				</p>
			)}
			{groups.map((group) =>
				group.kind === "summary" ? (
					<p key={group.id} data-turn-summary="" className="text-xs text-muted-foreground">
						{group.text}
					</p>
				) : group.kind === "message" ? (
					<article
						key={group.id}
						data-message-id={group.id}
						data-latest={!history && group.id === latest}
						className={`message ${group.role} ${group.role === "user" ? "max-w-[90%] self-end" : "min-w-0"}`}
					>
						<div className="sr-only">{group.role === "user" ? "你" : "燧明"}</div>
						{group.role === "user" ? (
							<UserMessage text={group.text} titles={titles} links={links} />
						) : (
							<Markdown
								className="msg-text"
								content={group.text}
								// 打开或切到一个已结束的会话要重放历史事件，重放到一半 generating 也是真的：
								// 最后一条消息因此按流式挂载、逐词淡入，长回复要三秒多才显示全（2026-10-05 走查，706 个词）。
								// 是否在生成以执行库的 session 状态为准，事件流只决定流到哪里。
								streaming={running && generating && group.id === latest}
								links={links}
							/>
						)}
						<MessageActions text={group.text} onReference={() => onReference(group.id, group.text)} />
					</article>
				) : group.taskId === undefined ? (
					// 根 Agent 的动作直接排在对话里，同类连着的并成一行；点开任何一行看完整输入与输出。
					group.rows.some((row) => !delegating.has(row.id)) && (
						<div key={group.rows[0]?.id} className="actions grid gap-1 text-xs text-muted-foreground">
							<ActionList
								sessionId={sessionId}
								taskId={undefined}
								rows={group.rows.filter((row) => !delegating.has(row.id))}
								titles={titles}
								open={open}
							/>
						</div>
					)
				) : (
					<SubtaskGroup
						key={group.rows[0]?.id}
						sessionId={sessionId}
						taskId={group.taskId}
						heading={[taskRoleLabel(taskOf(group.taskId)?.kind), taskOf(group.taskId)?.title]
							.filter(Boolean)
							.join(" · ")}
						status={taskOf(group.taskId)?.status}
						delegation={delegationOf(group.taskId)}
						rows={group.rows}
						showLog={showLog}
						titles={titles}
						open={open}
					/>
				),
			)}
			{!history && <InboxStatus sessionId={sessionId} />}
			{connectionState === "disconnected" && (
				<p role="status" className="text-xs text-muted-foreground">
					对话连接暂时中断，正在重新连接；Agent 的进度不会丢。
				</p>
			)}
		</div>
	);
}
function InboxStatus({ sessionId }: { sessionId: string }) {
	const query = useQuery({ queryKey: ["inbox", sessionId], queryFn: () => invoke("session.inbox", { sessionId }) });
	const waiting = query.data?.filter((item) => !item.delivered) ?? [];
	if (!waiting.length) return null;
	return (
		<details className="text-xs text-muted-foreground" open>
			<summary className="cursor-pointer">{waiting.length} 条消息等待处理</summary>
			{waiting.map((item) => (
				<p key={item.sequence} className="mt-2 whitespace-pre-wrap break-words">
					{item.text}
					<span className="mt-1 block">已发送，等待处理</span>
				</p>
			))}
		</details>
	);
}
