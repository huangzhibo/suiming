import { CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Hint } from "./ui-bits.js";

/**
 * 输入框底部的模式标记（ADR-0039）：讨论与目标共用一种样子，照 Codex 的计划 / 目标——只在开着时出现，图标加名字；
 * 悬停或键盘聚焦时图标换成 ⊗，点一下取消。输入框窄时只留图标，名字与说明在提示里。
 */
export function ComposerModeChip({
	icon,
	label,
	note,
	hint,
	pressed,
	disabled,
	onRemove,
}: {
	icon: ReactNode;
	label: string;
	/** 「待生效」这类附注，跟在名字后面。 */
	note?: string | undefined;
	hint: string;
	pressed: boolean;
	disabled: boolean;
	onRemove(): void;
}) {
	return (
		<Hint side="top" content={`${label}${note ? ` · ${note}` : ""}\n${hint}`}>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				className="group/mode shrink-0 gap-1 text-muted-foreground hover:bg-muted focus-visible:bg-muted"
				disabled={disabled}
				aria-label={label}
				aria-pressed={pressed}
				onClick={onRemove}
			>
				<span className="inline-flex group-hover/mode:hidden group-focus-visible/mode:hidden">{icon}</span>
				<CircleX className="hidden group-hover/mode:block group-focus-visible/mode:block" />
				<span className="@max-[300px]/composer:hidden">{label}</span>
				{note && <span className="text-[10px] @max-[300px]/composer:hidden">{note}</span>}
			</Button>
		</Hint>
	);
}
