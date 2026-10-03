import { ChevronDown, FileText, Folder, List, Search, User } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ToolButton } from "./ui-bits.js";
import type { SideMode } from "./view-state.js";

const modes = [
	{ id: "spine", name: "大纲", description: "按卷和故事顺序浏览作品", Icon: List },
	{ id: "files", name: "文件", description: "浏览作品目录中的源文件", Icon: Folder },
	{ id: "ids", name: "身份", description: "人物、地点、资源、读者期待与世界设定", Icon: User },
	{ id: "sources", name: "材料", description: "创作意图、原作、参考资料、审稿与版本", Icon: FileText },
	{ id: "search", name: "搜索", description: "搜索作品内容 · ⌘/Ctrl K", Icon: Search },
] as const satisfies { id: SideMode; name: string; description: string; Icon: typeof Folder }[];

export function NavigationModes({ value, onChange }: { value: SideMode; onChange(mode: SideMode): void }) {
	const current = modes.find((mode) => mode.id === value) ?? modes[0];
	const availableRef = useRef<HTMLDivElement>(null);
	const iconsRef = useRef<HTMLDivElement>(null);
	const [fits, setFits] = useState(true);
	useLayoutEffect(() => {
		const available = availableRef.current;
		const icons = iconsRef.current;
		if (!available || !icons) return;
		const measure = () => setFits(icons.getBoundingClientRect().width <= available.getBoundingClientRect().width);
		const observer = new ResizeObserver(measure);
		observer.observe(available);
		observer.observe(icons);
		measure();
		return () => observer.disconnect();
	}, []);
	return (
		<div ref={availableRef} className="relative flex min-w-0 flex-1 items-center">
			{/* 五个 28px 按钮保持命中范围，间距随可用宽度从 6px 收至 2px；再不足才收纳。 */}
			{/* 收纳时保留实际宽度测量，但隐藏图标不进入点击、键盘或辅助技术导航。 */}
			<div
				ref={iconsRef}
				data-navigation-icons
				inert={!fits}
				aria-hidden={!fits || undefined}
				className={cn(
					"flex w-full min-w-max max-w-[164px] shrink-0 items-center justify-between gap-0.5",
					!fits && "invisible absolute",
				)}
			>
				{modes.map(({ id, name, description, Icon }) => (
					<ToolButton
						key={id}
						label={name}
						description={description}
						on={value === id}
						className="shrink-0"
						onClick={() => onChange(id)}
					>
						<Icon />
					</ToolButton>
				))}
			</div>
			{!fits && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							aria-label={`切换导航：${current.name}`}
							className="no-drag h-6 min-w-0 gap-1.5 px-1.5 text-xs text-muted-foreground hover:text-sub focus-visible:text-sub"
						>
							<current.Icon />
							<span className="truncate">{current.name}</span>
							<ChevronDown className="size-3 shrink-0 text-muted-foreground" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-40">
						<DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as SideMode)}>
							{modes.map(({ id, name, Icon }) => (
								<DropdownMenuRadioItem key={id} value={id}>
									<Icon className="size-4" />
									{name}
									{id === "search" && <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
