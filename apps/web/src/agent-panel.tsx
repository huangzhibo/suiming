import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Ellipsis, Maximize2, Minimize2, Plus } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AgentComposer, type ComposerBinding } from "./agent-composer.js";
import { Transcript } from "./agent-transcript.js";
import { bridge, invoke } from "./bridge.js";
import { type ConversationPosition, ConversationViewport } from "./conversation-viewport.js";
import type { Book, SessionSummary } from "./model.js";
import { useModelSettings } from "./model-settings.js";
import {
	isSessionActive as isActive,
	sessionStatusLabels as labels,
	sessionProblem,
	taskKindLabel,
} from "./run-presentation.js";
import { ActionButton, PanelToolbar, ToolButton } from "./ui-bits.js";

type Session = SessionSummary;

function TaskTree({ sessionId }: { sessionId: string }) {
	const tasks = useQuery({ queryKey: ["tasks", sessionId], queryFn: () => invoke("session.tasks", { sessionId }) });
	if (!tasks.data?.length) return null;
	return (
		<details className="task-tree text-[11.5px] text-muted-foreground">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
				<ChevronRight className="size-[9px]" />
				子任务 · {tasks.data.length}
			</summary>
			<ol className="m-0 list-none pt-1.5 pl-3.5">
				{tasks.data.map((task) => (
					<li
						key={task.id}
						className={`py-[5px] ${task.parentTaskId ? "ml-1.5 border-l border-border pl-3" : ""}`}
					>
						<div className="flex items-baseline gap-2">
							<span
								className={`inline-block size-1.5 flex-none rounded-full ${task.status === "completed" ? "bg-muted-foreground" : task.status === "running" ? "bg-amber" : "bg-faint"}`}
							/>
							<strong className="font-medium text-ink-3">{taskKindLabel(task.kind)}</strong>
							<small className="ml-auto whitespace-nowrap">
								{{ running: "执行中", completed: "完成", failed: "失败", interrupted: "已中断" }[task.status] ??
									task.status}
							</small>
						</div>
					</li>
				))}
			</ol>
		</details>
	);
}

export interface AgentPanelProps extends ComposerBinding {
	position: ConversationPosition | undefined;
	onPosition(value: ConversationPosition): void;
	book: Book;
	sessions: Session[];
	selected: string;
	onSelect(id: string): void;

	refresh(): void;
	open(page: string): void;
	/** 设置是模态框，不是页面。 */
	openSettings(): void;
	expanded: boolean;
	toggleExpand(): void;
}
/**
 * 待确认的调用数由存储形状派生：`confirmedCalls` 缺省表示历史记录全部已确认。
 */
function unconfirmedCalls(usage: { calls: number; confirmedCalls?: number }): number {
	return Math.max(0, usage.calls - (usage.confirmedCalls ?? usage.calls));
}

function sessionTitle(session: Session): string {
	return [...(session.title.split("\n")[0] ?? "新对话").trim()].slice(0, 48).join("") || "新对话";
}

export function AgentPanel({
	book,
	sessions,
	selected,
	onSelect,
	position,
	onPosition,
	refresh,
	open,
	openSettings,
	expanded,
	toggleExpand,
	...binding
}: AgentPanelProps) {
	const titles = useMemo(() => new Map([...book.byPath].map(([path, file]) => [path, book.title(file)])), [book]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [picker, setPicker] = useState(false);
	const [showLog, setShowLog] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [exports, setExports] = useState<Record<string, string>>({});
	const receiveExport = useCallback((id: string, text: string) => {
		setExports((previous) => (previous[id] === text ? previous : { ...previous, [id]: text }));
	}, []);
	const [exportNotice, setExportNotice] = useState("");
	const setGoal = (goal: string) => binding.updateComposer(binding.draftKey, (draft) => ({ ...draft, goal }));
	const session = sessions.find((item) => item.id === selected);
	const exported = session ? (exports[session.id] ?? "") : "";
	const active = isActive(session);
	// 开始对话前先看 Agent 有没有可用模型；主进程的预检会拦住，但提前说明比失败后再解释省一次来回。
	const agent = useModelSettings().data?.profiles.find((profile) => profile.id === "main");
	const agentBlocked = !binding.composer.model && agent !== undefined && agent.state !== "ready";
	const intents = book.data.files.filter((file) => file.kind === "intent");
	async function action(body: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await body();
			refresh();
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	}

	const resumeCommand = useRef<{ fingerprint: string; commandId: string } | undefined>(undefined);
	const problem = session ? sessionProblem(session) : undefined;
	const resume = (retryUnknown: boolean) => {
		if (!session) return;
		const input = {
			sessionId: session.id,
			...(retryUnknown ? { retryUnknown: true } : {}),
			...(!retryUnknown && binding.composer.model ? { model: binding.composer.model } : {}),
		};
		const fingerprint = JSON.stringify(input);
		if (resumeCommand.current?.fingerprint !== fingerprint)
			resumeCommand.current = { fingerprint, commandId: crypto.randomUUID() };
		const commandId = resumeCommand.current.commandId;
		return action(async () => {
			await invoke("session.resume", { commandId, ...input });
			resumeCommand.current = undefined;
		});
	};

	const groups = [
		{ label: "进行中", items: sessions.filter((item) => item.status !== "idle") },
		{ label: "最近", items: sessions.filter((item) => item.status === "idle") },
	].filter((group) => group.items.length);
	return (
		// clip 而不是 hidden：hidden 的容器仍能被 scrollIntoView 滚动，滚了整栏就上移、输入框浮到中间，又没有滚动条拉回来。
		<div className="flex min-h-0 flex-1 flex-col overflow-clip">
			<PanelToolbar className="justify-center">
				<ToolButton
					label="新对话"
					onClick={() => {
						onSelect("");
					}}
				>
					<Plus />
				</ToolButton>
				<ToolButton label={expanded ? "收回为侧栏" : "展开为主工作面"} on={expanded} onClick={toggleExpand}>
					{expanded ? <Minimize2 /> : <Maximize2 />}
				</ToolButton>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="tool" size="tool" aria-label="对话菜单">
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuGroup>
							{intents[0] && (
								<DropdownMenuItem onSelect={() => intents[0] && open(intents[0].path)}>
									打开创作意图
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onSelect={() => setShowLog(!showLog)}>
								{showLog ? "收起执行记录" : "展开执行记录"}
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!exported || busy}
								onSelect={() =>
									action(async () => {
										setExportNotice("");
										if (await bridge().exportConversation(exported)) setExportNotice("对话已导出");
									})
								}
							>
								{exported ? "导出对话…" : "导出对话（还没有消息）"}
							</DropdownMenuItem>
						</DropdownMenuGroup>
						{session && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									{/* 菜单项禁用时直接写出原因：窄窗口里没有悬停提示。 */}
									<DropdownMenuItem disabled={busy || active} onSelect={() => setConfirmDelete(true)}>
										{active ? "删除对话（先停止当前回复）" : "删除对话…"}
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</PanelToolbar>
			{/* session.delete 是硬删除：消息与执行记录都没了，不能只点一下菜单就删。 */}
			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除这个对话？</DialogTitle>
						<DialogDescription>
							对话里的消息与执行记录会一起删除，不能恢复。作品文件与版本不受影响。
						</DialogDescription>
					</DialogHeader>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => setConfirmDelete(false)}>
							取消
						</Button>
						<Button
							variant="destructive"
							disabled={busy || active || !session}
							onClick={() =>
								action(async () => {
									if (!session) return;
									await invoke("session.delete", { sessionId: session.id });
									setConfirmDelete(false);
									onSelect("");
								})
							}
						>
							删除对话
						</Button>
					</div>
				</DialogContent>
			</Dialog>
			<ConversationViewport key={selected || "new"} position={position} onPosition={onPosition} expanded={expanded}>
				{sessions.length > 0 && (
					<Popover open={picker} onOpenChange={setPicker}>
						<PopoverTrigger asChild>
							<button
								type="button"
								aria-label="选择对话"
								className="run-status flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-1.5 text-left text-xs text-foreground hover:bg-muted"
							>
								<span
									className={`size-1.5 shrink-0 rounded-full ${session ? (session.status === "idle" ? "bg-faint" : "bg-muted-foreground") : "bg-faint"}`}
								/>
								<span className="min-w-0 flex-1 truncate">{session ? sessionTitle(session) : "新对话"}</span>
								<span className="text-[11px] whitespace-nowrap text-muted-foreground">
									{session ? (labels[session.status] ?? session.status) : `${sessions.length} 个对话`}
								</span>
								<ChevronDown className="size-[10px] text-muted-foreground" />
							</button>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1.5">
							{groups.map((group) => (
								<div key={group.label}>
									<div className="px-2 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">{group.label}</div>
									{[...group.items].reverse().map((item) => (
										<button
											type="button"
											key={item.id}
											className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted data-[on=true]:bg-control-selected"
											data-on={item.id === selected}
											onClick={() => {
												onSelect(item.id);
												setPicker(false);
											}}
										>
											<span className="flex items-center gap-1.5 text-[12.5px]">
												<span
													className={`size-1.5 rounded-full ${item.status === "idle" ? "bg-faint" : "bg-muted-foreground"}`}
												/>
												<span className="truncate">{sessionTitle(item)}</span>
											</span>
											<span className="pl-3 text-[11px] text-muted-foreground">
												{labels[item.status] ?? item.status}
											</span>
										</button>
									))}
								</div>
							))}
						</PopoverContent>
					</Popover>
				)}
				{session ? (
					<>
						{showLog && (
							<>
								{session.usage && (
									<p className="m-0 text-xs text-muted-foreground">
										累计用量：{session.usage.totalTokens.toLocaleString()} tokens · ≈ $
										{session.usage.costUsd.toFixed(3)}
										{unconfirmedCalls(session.usage)
											? ` · ${unconfirmedCalls(session.usage)} 次用量待确认`
											: ""}
									</p>
								)}
								<TaskTree sessionId={session.id} />
							</>
						)}
						<Transcript
							key={session.id}
							sessionId={session.id}
							showLog={showLog}
							titles={titles}
							open={open}
							onExport={receiveExport}
							onReference={(id, text) =>
								binding.updateComposer(binding.draftKey, (draft) => ({
									...draft,
									attachments: [
										...(draft.attachments ?? []),
										{
											id: crypto.randomUUID(),
											kind: "message",
											status: "ready",
											label: "对话引用",
											content: `对话引用：${session.id} / ${id}\n\n${text}`,
										},
									],
								}))
							}
						/>
						<div
							className={`run-controls flex flex-wrap gap-2 ${problem ? "rounded-lg border bg-muted/40 px-3 py-2.5" : ""}`}
						>
							{problem && (
								<div role={problem.paused ? "alert" : "status"} className="w-full text-xs leading-relaxed">
									<strong className="font-medium">{problem.title}</strong>
									<p className="mt-1 text-muted-foreground">{problem.hint}</p>
									{problem.detail && (
										<details className="mt-2 text-muted-foreground">
											<summary className="cursor-pointer">查看原因</summary>
											<p className="mt-1 whitespace-pre-wrap break-words">{problem.detail}</p>
										</details>
									)}
								</div>
							)}
							{problem?.paused && (
								<>
									<ActionButton
										variant="outline"
										size="xs"
										disabled={busy}
										disabledReason={
											problem.unknownModelCall
												? "上一次模型请求的结果不确定，直接继续可能重复花费：先确认重新请求，或放弃这次核对"
												: undefined
										}
										onClick={() => resume(false)}
									>
										继续
									</ActionButton>
									{problem.unknownModelCall && (
										<Button variant="outline" size="xs" disabled={busy} onClick={() => resume(true)}>
											确认重新请求模型
										</Button>
									)}
									<Button
										variant="ghost"
										size="xs"
										disabled={busy}
										onClick={() => action(() => invoke("session.interrupt", { sessionId: session.id }))}
									>
										放弃这次核对
									</Button>
								</>
							)}
						</div>
					</>
				) : (
					<div className="px-1 py-2">
						<h3 className="mb-2 text-[15px] font-semibold">把故事往前推进。</h3>
						<p className="mb-3.5 text-xs leading-[1.8] text-muted-foreground">聊聊你的想法，或一起修改作品。</p>
						<div className="grid gap-1.5">
							{["检查主角的选择是否有足够代价", "找出尚未兑现的伏笔", "独立审查这一卷的因果"].map((text) => (
								<button
									type="button"
									key={text}
									className="flex cursor-pointer justify-between gap-3 rounded-md border bg-white px-2.5 py-2 text-left text-xs leading-[1.6] hover:border-faint"
									onClick={() => setGoal(text)}
								>
									{text}
									<span className="text-faint">↗</span>
								</button>
							))}
						</div>
					</div>
				)}
			</ConversationViewport>
			<AgentComposer
				{...binding}
				book={book}
				session={session}
				expanded={expanded}
				refresh={refresh}
				openSettings={openSettings}
			/>
			{exportNotice && (
				<p role="status" className="text-xs text-muted-foreground">
					{exportNotice}
				</p>
			)}
			{error && (
				<p role="alert" className="px-4 pb-2 text-xs text-destructive">
					{error}
				</p>
			)}
			{!session && agentBlocked && (
				<p role="status" className="px-4 pb-2 text-xs text-muted-foreground">
					{agent.detail}
					从模型菜单打开设置后配置提供商。
				</p>
			)}
		</div>
	);
}
