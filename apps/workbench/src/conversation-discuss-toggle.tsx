import { Button } from "@/components/ui/button";
import { Hint } from "./ui-bits.js";

/**
 * 讨论开关（ADR-0039）：开着时 Agent 只读、只出方案，由根 Agent 的工具面保证，这里只是入口；`/讨论` 是同一个开关。
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
	const pending = active && choice !== undefined && choice !== effective;
	return (
		<Hint
			side="top"
			content={
				pending
					? `这一轮仍${effective ? "在讨论" : "没开讨论"}；新选择随下一条消息生效`
					: selected
						? "讨论开着：Agent 只读，只出方案，不改文件、不提交。再点一下关上\n/讨论"
						: "打开讨论：Agent 只读，只出方案，等你关上再动手\n/讨论"
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
				<span>讨论</span>
				{pending && <span className="text-[10px]">待生效</span>}
			</Button>
		</Hint>
	);
}
