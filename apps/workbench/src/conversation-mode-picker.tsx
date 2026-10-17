import type { CollaborationMode } from "@suiming/sdk";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "./ui-bits.js";

/** 协作模式（ADR-0038）：由 Agent 的工具面保证，这里只是选择入口。 */
export const COLLABORATION_MODE_OPTIONS: readonly { mode: CollaborationMode; label: string; detail: string }[] = [
	{ mode: "discuss", label: "讨论", detail: "只读：Agent 只出方案，不改文件、不提交" },
	{ mode: "collaborate", label: "协作", detail: "Agent 改候选，由你提交" },
	{ mode: "autonomous", label: "自主", detail: "Agent 改完自己提交" },
];

export function collaborationModeLabel(mode: CollaborationMode): string {
	return COLLABORATION_MODE_OPTIONS.find((option) => option.mode === mode)?.label ?? mode;
}

export function ConversationModePicker({
	choice,
	current,
	active,
	disabled,
	onChange,
}: {
	choice?: CollaborationMode | undefined;
	current?: CollaborationMode | undefined;
	active: boolean;
	disabled: boolean;
	onChange(mode: CollaborationMode): void;
}) {
	const effective = current ?? "autonomous";
	const selected = choice ?? effective;
	// 与换模型相同：正在回复时不打断这一轮，新选择随下一条消息生效（Runtime 对正在跑的对话换模式会拒绝）。
	const pending = active && choice !== undefined && choice !== effective;
	return (
		<DropdownMenu>
			<Hint
				side="top"
				content={
					pending
						? `这一轮仍是「${collaborationModeLabel(effective)}」；新选择随下一条消息生效`
						: "协作模式：讨论只读，协作由你提交，自主由 Agent 提交"
				}
			>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="xs"
							className="shrink-0 gap-1 text-muted-foreground"
							disabled={disabled}
							aria-label="协作模式"
							data-collaboration-mode={selected}
						>
							<span>{collaborationModeLabel(selected)}</span>
							{pending && <span className="text-[10px]">待生效</span>}
							<ChevronDown />
						</Button>
					}
				/>
			</Hint>
			<DropdownMenuContent side="top" align="start" className="w-[260px]">
				<DropdownMenuRadioGroup value={selected} onValueChange={(value) => onChange(value as CollaborationMode)}>
					{/* Base UI 的 GroupLabel 只认所在的组，放在组外读屏关联不上 */}
					<DropdownMenuLabel>协作模式 · 当前对话</DropdownMenuLabel>
					{COLLABORATION_MODE_OPTIONS.map((option) => (
						<DropdownMenuRadioItem key={option.mode} value={option.mode}>
							<span className="flex flex-col gap-0.5">
								<span>{option.label}</span>
								<span className="text-xs text-muted-foreground">{option.detail}</span>
							</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
