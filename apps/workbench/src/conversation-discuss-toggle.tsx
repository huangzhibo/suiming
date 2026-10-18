import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "./ui-bits.js";

/**
 * 讨论标记（ADR-0039）：开着时 Agent 只读、只出方案，由根 Agent 的工具面保证，这里只是状态与关上的入口。
 * 关着时不占位置，用 `/讨论` 打开——Claude Code 也只在不是默认模式时才显示模式。
 * 与换模型一样：正在回复时不打断这一轮，新选择随下一条消息生效（Runtime 对正在跑的对话开关讨论会拒绝）。
 */
export function ConversationDiscussToggle({
	choice,
	current,
	active,
	disabled,
	onChange,
}: {
	choice?: boolean | undefined;
	current?: boolean | undefined;
	active: boolean;
	disabled: boolean;
	onChange(discuss: boolean): void;
}) {
	const effective = current === true;
	const selected = choice ?? effective;
	const pending = active && selected !== effective;
	if (!selected && !pending) return null;
	return (
		<Hint
			side="top"
			content={
				pending
					? selected
						? "这一轮还没开讨论；随下一条消息打开"
						: "这一轮仍在讨论；随下一条消息关上"
					: "讨论开着：Agent 只读，只出方案，不改文件、不提交。点一下关上\n/讨论"
			}
		>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				className="shrink-0 gap-1 text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
				disabled={disabled}
				aria-label="讨论"
				aria-pressed={selected}
				onClick={() => onChange(!selected)}
			>
				<span>{selected ? "讨论中" : "讨论"}</span>
				{pending && <span className="text-[10px]">{selected ? "待生效" : "待关上"}</span>}
				{selected && <X />}
			</Button>
		</Hint>
	);
}
