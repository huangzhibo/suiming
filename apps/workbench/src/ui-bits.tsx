import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useRender } from "@base-ui/react/use-render";
import {
	type ComponentProps,
	type HTMLAttributes,
	type ReactElement,
	type ReactNode,
	type Ref,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** 工作面与侧栏共用工具行：固定 37px 高度、15px 图标，不设底部分割线。 */
export function PanelToolbar({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-panel-toolbar
			className={cn("flex h-[var(--panel-toolbar-height)] shrink-0 items-center gap-4 px-3", className)}
			{...props}
		/>
	);
}

/** 工作面里的空状态：虚线框加一段说明，下面可以接动作按钮。故事轴与正文页共用。 */
export function EmptyNote({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"rounded-lg border border-dashed border-[#d4d4d8] px-5 py-[18px] text-[12.5px] leading-[1.7] text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}

/** 简短补充说明；复用实际触发元素，不额外改变行、树或分栏布局。 */
export function Hint({
	content,
	children,
	side = "bottom",
	ref,
	...props
}: Omit<HTMLAttributes<HTMLElement>, "content" | "children"> & {
	ref?: Ref<HTMLElement>;
	content?: ReactNode;
	children: ReactElement;
	side?: "top" | "bottom" | "left" | "right";
}) {
	// 没有提示时只把外层（比如弹层的触发器）传下来的属性与 ref 并到子元素上，不多包一层。
	const plain = useRender({ render: children, props, ref, enabled: !content });
	if (!content) return plain;
	return (
		<Tooltip>
			<TooltipTrigger ref={ref as Ref<HTMLButtonElement>} render={children} {...props} />
			<TooltipContent side={side}>{content}</TooltipContent>
		</Tooltip>
	);
}

const overflowTargets = (element: HTMLElement | null) =>
	element ? [element, ...element.querySelectorAll<HTMLElement>(".truncate")] : [];
const isClipped = (element: HTMLElement) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth;

/** 仅补全被省略的文字；完整名称不重复提示。触发时测量，打开期间随宽度变化关闭。 */
export function OverflowHint({
	content,
	children,
	side = "bottom",
}: {
	content: string;
	children: ReactElement;
	side?: "top" | "bottom" | "left" | "right";
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (!open) return;
		const elements = overflowTargets(trigger.current);
		const update = () => {
			if (!content || !elements.some(isClipped)) setOpen(false);
		};
		update();
		const observer = new ResizeObserver(update);
		for (const element of elements) observer.observe(element);
		return () => observer.disconnect();
	}, [open, content]);
	return (
		<Tooltip
			open={open}
			onOpenChange={(next) => setOpen(next && !!content && overflowTargets(trigger.current).some(isClipped))}
		>
			<TooltipTrigger ref={trigger} render={children} />
			<TooltipContent side={side}>{content}</TooltipContent>
		</Tooltip>
	);
}

/** 图标按钮使用简短动作名，说明和不可用原因放在提示中。 */
export function ToolButton({
	label,
	description,
	disabledReason,
	disabled,
	onClick,
	on = false,
	className,
	children,
	side = "bottom",
	...props
}: ComponentProps<typeof Button> & {
	label: string;
	description?: string;
	disabledReason?: string;
	on?: boolean;
	side?: "top" | "bottom" | "left" | "right";
}) {
	const detail = disabled ? (disabledReason ?? description) : description;
	return (
		<Hint side={side} content={detail ? `${label}\n${detail}` : label}>
			<Button
				type="button"
				variant="tool"
				size="tool"
				aria-label={label}
				aria-disabled={disabled || undefined}
				aria-description={detail}
				aria-pressed={on || undefined}
				data-on={on}
				className={cn("no-drag", className)}
				{...props}
				onClick={(event) => {
					// aria-disabled 保留 hover / 键盘说明；仍阻止鼠标、Enter 和 Space 发起动作。
					if (disabled) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					onClick?.(event);
				}}
			>
				{children}
			</Button>
		</Hint>
	);
}

/**
 * 文字按钮，规则与 ToolButton 相同：因为状态而不可用时用 aria-disabled，悬停与键盘聚焦仍能看到原因，动作照样拦住。
 * 只是「正在处理」这种一闪而过的不可用照旧传 disabled，不必说原因。
 */
export function ActionButton({
	disabledReason,
	onClick,
	className,
	side = "bottom",
	...props
}: ComponentProps<typeof Button> & {
	disabledReason?: string | undefined;
	side?: "top" | "bottom" | "left" | "right";
}) {
	return (
		<Hint side={side} content={disabledReason}>
			<Button
				aria-disabled={disabledReason ? true : undefined}
				aria-description={disabledReason}
				className={cn(
					"aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-background",
					className,
				)}
				{...props}
				onClick={(event) => {
					if (disabledReason) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}
					onClick?.(event);
				}}
			/>
		</Hint>
	);
}

/**
 * 视图切换：一组单选、不可取消的分段按钮。用 Base UI 的 RadioGroup 而不是 ToggleGroup：
 * 互斥的视图在读屏里应当是一组 radio（Radix 的单选 ToggleGroup 原来就是这样），Base UI 的 ToggleGroup 只给 aria-pressed。
 */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	className,
}: {
	value: T;
	options: { id: T; label: string; icon?: ReactNode; title?: string; disabled?: boolean }[];
	onChange(value: T): void;
	className?: string;
}) {
	return (
		<RadioGroup
			value={value}
			onValueChange={(next) => {
				if (typeof next === "string" && !options.find((option) => option.id === next)?.disabled)
					onChange(next as T);
			}}
			className={cn("flex w-fit shrink-0 items-center gap-1 rounded-md bg-muted p-0.5", className)}
		>
			{options.map((option) => (
				<Hint key={option.id} content={option.title}>
					<Radio.Root
						value={option.id}
						aria-disabled={option.disabled || undefined}
						onClick={(event) => {
							if (option.disabled) event.preventDefault();
						}}
						aria-label={option.label}
						aria-description={option.title}
						className="inline-flex h-[22px] cursor-pointer items-center justify-center gap-1.5 rounded px-2.5 text-[11.5px] font-medium whitespace-nowrap text-muted-foreground outline-none transition-[color,box-shadow] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-disabled:cursor-default aria-disabled:opacity-50 aria-checked:bg-white aria-checked:text-foreground aria-checked:shadow-[0_1px_2px_#00000014] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[13px]"
					>
						{option.icon}
						{option.label}
					</Radio.Root>
				</Hint>
			))}
		</RadioGroup>
	);
}

/** 语义色标签：shadcn Badge 的 tone 变体，方角以贴近设计稿。 */
export function Tag({
	tone,
	className,
	...props
}: Omit<ComponentProps<typeof Badge>, "variant"> & { tone: "green" | "amber" | "purple" | "red" | "gray" }) {
	return <Badge variant={tone} className={cn("rounded px-1.5 py-px font-semibold", className)} {...props} />;
}

/** 语义色对应的文字类，供状态行与依据栏复用。 */
export const toneText = (tone: "green" | "amber" | "purple" | "red" | "gray" | undefined) =>
	tone === "amber"
		? "text-amber"
		: tone === "gray"
			? "text-muted-foreground"
			: tone === "purple"
				? "text-purple"
				: tone === "red"
					? "text-red-ink"
					: "text-success";
/** 审稿的层与时效：所有地方用同一种说法（原来「待复核」「依据已变化」「关联内容已有更新」「stale」各说各的）。 */
export const reviewLayerLabel = (layer: string) => ({ design: "设计", text: "正文", source: "原作" })[layer] ?? layer;
export const reviewCurrencyLabel = (current: boolean) => (current ? "对应当前稿" : "稿子已改，需重新核对");
