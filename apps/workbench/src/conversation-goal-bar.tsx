import type { GoalAction, SessionGoal } from "@suiming/sdk";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "./ui-bits.js";

const STATUS: Record<SessionGoal["status"], string> = {
	active: "进行中",
	paused: "已暂停",
	blocked: "等你拍板",
	complete: "已完成",
};

/**
 * 对话的目标（ADR-0038）：输入框上方一行，写明目标、状态与原因；继续、暂停、清除与 `/目标 继续|暂停|清除`
 * 是同一个命令。对话正在回复时都不能点：跑着时目标只归持有 turn 的进程改，要停先按停止（停止即暂停）。
 */
export function ConversationGoalBar({
	goal,
	running,
	busy,
	onAction,
}: {
	goal: SessionGoal;
	running: boolean;
	busy: boolean;
	onAction(action: GoalAction): void;
}) {
	const disabled = running || busy;
	const reason = running ? "对话正在回复；要停下就按停止，目标随之暂停" : undefined;
	return (
		<div
			className="mb-2 flex min-w-0 items-start gap-2 rounded-lg border bg-muted px-2 py-1.5 text-xs"
			role="status"
			aria-label="对话目标"
			data-goal-status={goal.status}
		>
			<Target className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<p className="truncate">
					<span className="font-medium">目标 · {STATUS[goal.status]}</span>
					{goal.autoTurns > 0 && <span className="text-muted-foreground"> · 已自动续跑 {goal.autoTurns} 轮</span>}
					<span className="text-muted-foreground"> · {goal.objective}</span>
				</p>
				{goal.reason && goal.status !== "active" && (
					<p className="mt-0.5 line-clamp-2 text-muted-foreground">{goal.reason}</p>
				)}
			</div>
			<div className="flex shrink-0 gap-1">
				{goal.status !== "complete" && (
					<Hint
						side="top"
						content={reason ?? (goal.status === "active" ? "停下自动续跑，之后可以继续" : "接着自动续跑")}
					>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							disabled={disabled}
							onClick={() => onAction(goal.status === "active" ? "pause" : "resume")}
						>
							{goal.status === "active" ? "暂停" : "继续"}
						</Button>
					</Hint>
				)}
				<Hint side="top" content={reason ?? "去掉这个目标，对话照常继续"}>
					<Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => onAction("clear")}>
						清除
					</Button>
				</Hint>
			</div>
		</div>
	);
}
