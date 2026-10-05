import { BookOpen, ChevronDown, ClipboardCheck, Columns2, File, Pin, Plus, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Book, pageKind, type ReviewReport } from "./model.js";
import { Hint, OverflowHint, ToolButton } from "./ui-bits.js";
import type { PageState, WorkbenchTab } from "./view-state.js";

/** 一个文档窗格顶上的标签栏：标签、右键菜单、新标签与「已打开的标签页」列表。 */
export function TabStrip({
	tabs,
	active,
	book,
	reviews,
	insetLeft,
	insetRight,
	unsaved,
	onActivate,
	onClose,
	onTogglePin,
	onDuplicate,
	onNewTab,
}: {
	tabs: WorkbenchTab[];
	active: number;
	book: Book;
	reviews: ReviewReport[];
	/** 左栏收起时给展开按钮让位（只有最左的窗格）；右栏同理。 */
	insetLeft: boolean;
	insetRight: boolean;
	/** 这个标签上有没有未保存的草稿。 */
	unsaved: (location: PageState) => boolean;
	onActivate: (index: number) => void;
	onClose: (index: number) => void;
	onTogglePin: (id: string) => void;
	onDuplicate: (location: PageState) => void;
	onNewTab: () => void;
}) {
	return (
		<div
			className="drag relative flex h-(--workbench-header-height) min-w-0 shrink-0 items-end border-b border-line bg-titlebar pl-2"
			// 用外边距避开两侧的展开按钮；padding 仍属于 Electron 原生拖动区，会吞掉鼠标点击。外边距必须与按钮块
			// 一样宽（左 --side-toggle-width、右 w-11）：多出来的部分露出窗格的 chrome 底色，曾经在标签左边留下一道灰条。
			style={{
				marginLeft: insetLeft ? "var(--side-toggle-width)" : undefined,
				marginRight: insetRight ? 44 : undefined,
			}}
		>
			{tabs.map((item, index) => (
				<ContextMenu key={item.id}>
					<ContextMenuTrigger asChild>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: 标签本身承载关闭按钮，不能再嵌套 button */}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用户通过标签内的可聚焦元素与 ⌘W 操作 */}
						<div
							className="tab-btn"
							data-tab-id={item.id}
							data-active={index === active}
							onClick={() => onActivate(index)}
							onAuxClick={(event) => event.button === 1 && onClose(index)}
						>
							{item.pinned ? (
								<Pin className="size-3 shrink-0 text-muted-foreground" />
							) : (
								tabIcon(book, item.location.page)
							)}
							{unsaved(item.location) && (
								<span className="size-1.5 shrink-0 rounded-full bg-amber" role="img" aria-label="未保存" />
							)}
							<OverflowHint content={book.pageTitle(item.location.page, reviews)}>
								<button
									type="button"
									className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13px]"
									aria-current={index === active ? "page" : undefined}
									onClick={() => onActivate(index)}
								>
									{book.pageTitle(item.location.page, reviews)}
								</button>
							</OverflowHint>
							<Hint content={"关闭标签页 · ⌘/Ctrl W"}>
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label="关闭标签"
									className={`size-5 shrink-0 rounded text-muted-foreground hover:text-foreground ${index === active ? "" : "hidden"}`}
									onClick={(event) => {
										event.stopPropagation();
										onClose(index);
									}}
								>
									<X className="size-[11px]" />
								</Button>
							</Hint>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuGroup>
							<ContextMenuItem onSelect={() => onTogglePin(item.id)}>
								{item.pinned ? "取消固定标签页" : "固定标签页"}
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => onDuplicate(item.location)}>复制标签页</ContextMenuItem>
							<ContextMenuItem onSelect={() => onClose(index)}>关闭标签页</ContextMenuItem>
						</ContextMenuGroup>
					</ContextMenuContent>
				</ContextMenu>
			))}
			<ToolButton
				label="新标签页"
				description="打开空白选择页 · ⌘/Ctrl T"
				className="ml-1.5 self-center text-muted-foreground"
				onClick={onNewTab}
			>
				<Plus className="size-[14px]" />
			</ToolButton>
			<span className="flex-1" />
			{tabs.length > 1 && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Hint content={"查看已打开的标签页"}>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="标签页列表"
								className="no-drag mr-1.5 size-7 self-center text-muted-foreground"
							>
								<ChevronDown className="size-[14px]" />
							</Button>
						</Hint>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="max-w-[320px]">
						{tabs.map((item, index) => (
							<DropdownMenuItem
								key={item.id}
								onSelect={() => onActivate(index)}
								className={index === active ? "font-medium" : ""}
							>
								{tabIcon(book, item.location.page)}
								<span className="truncate">{book.pageTitle(item.location.page, reviews)}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

function tabIcon(book: Book, tab: string) {
	const kind = pageKind(tab);
	if (kind === "diff") return <Columns2 className="size-[14px] shrink-0 text-muted-foreground" />;
	if (kind === "spine") return <Table2 className="size-[14px] shrink-0 text-muted-foreground" />;
	if (kind === "check") return <ClipboardCheck className="size-[14px] shrink-0 text-muted-foreground" />;
	if (
		kind === "artifact" &&
		(book.byPath.get(tab)?.kind === "story-beat" || book.byPath.get(tab)?.kind === "story-text")
	)
		return <BookOpen className="size-[14px] shrink-0 text-muted-foreground" />;
	return <File className="size-[14px] shrink-0 text-muted-foreground" />;
}
