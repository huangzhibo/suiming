import { ArrowDown, ArrowUp, ChevronDown, Columns2, RotateCcw, Rows3 } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ComparisonController, ComparisonStatus } from "./code-editor.js";
import type { Book } from "./model.js";
import { ToolButton } from "./ui-bits.js";
import type { ComparisonLayout, ViewState } from "./view-state.js";

export function ComparisonActions({
	controller,
	status,
	identical,
	layout,
	onLayout,
}: {
	controller: RefObject<ComparisonController | null>;
	status: ComparisonStatus | null;
	identical: string;
	layout: ComparisonLayout;
	onLayout(value: ComparisonLayout): void;
}) {
	return (
		<div role="toolbar" className="flex min-w-0 items-center gap-1" aria-label="差异导航">
			<span role="status" className="truncate px-1 text-xs text-muted-foreground">
				{status
					? status.count
						? `${status.active ? `${status.active} / ` : ""}${status.count} 处差异`
						: identical
					: ""}
			</span>
			<ToolButton
				label="上一处差异"
				disabled={!status?.count}
				disabledReason="两侧内容相同，没有差异"
				onClick={() => controller.current?.previous()}
			>
				<ArrowUp />
			</ToolButton>
			<ToolButton
				label="下一处差异"
				disabled={!status?.count}
				disabledReason="两侧内容相同，没有差异"
				onClick={() => controller.current?.next()}
			>
				<ArrowDown />
			</ToolButton>
			<ToolButton
				label="还原当前差异"
				description="把选中的变更块恢复为比较基线，写入当前草稿"
				disabled={!status?.active}
				disabledReason={status?.count ? "先用上一处 / 下一处选中一处差异" : "两侧内容相同，没有差异"}
				onClick={() => controller.current?.restore()}
			>
				<RotateCcw />
			</ToolButton>
			<ToolButton
				label={layout === "split" ? "切换为单栏差异" : "切换为并排差异"}
				onClick={() => onLayout(layout === "split" ? "unified" : "split")}
			>
				{layout === "split" ? <Rows3 /> : <Columns2 />}
			</ToolButton>
		</div>
	);
}

export function ComparisonOptions({
	view,
	patch,
	layout,
}: {
	view: ViewState;
	layout: ComparisonLayout;
	patch(value: Partial<ViewState>): void;
}) {
	return (
		<>
			<DropdownMenuRadioGroup
				value={view.diffLayout ?? "auto"}
				onValueChange={(value) => patch({ diffLayout: value === "auto" ? null : (value as ComparisonLayout) })}
			>
				<DropdownMenuRadioItem value="auto">跟随窗口宽度</DropdownMenuRadioItem>
				<DropdownMenuRadioItem value="unified">单栏差异</DropdownMenuRadioItem>
				<DropdownMenuRadioItem value="split">并排差异</DropdownMenuRadioItem>
			</DropdownMenuRadioGroup>
			<DropdownMenuSeparator />
			{layout === "split" && (
				<DropdownMenuCheckboxItem checked={view.diffSync} onCheckedChange={(diffSync) => patch({ diffSync })}>
					联动滚动
				</DropdownMenuCheckboxItem>
			)}
			<DropdownMenuCheckboxItem
				checked={view.diffChangesOnly}
				onCheckedChange={(diffChangesOnly) => patch({ diffChangesOnly })}
			>
				仅显示差异附近内容
			</DropdownMenuCheckboxItem>
			<DropdownMenuSeparator />
		</>
	);
}

export function ComparisonBaseline({
	book,
	view,
	patch,
}: {
	book: Book;
	view: ViewState;
	patch(value: Partial<ViewState>): void;
}) {
	if (view.diffExternal) return <span>外部文件 · 只读</span>;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button size="xs" variant="ghost" aria-label="选择比较基线">
					已提交 · {view.diffRevision ? book.revisionLabel(view.diffRevision) : "无版本"}
					<ChevronDown data-icon="inline-end" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuRadioGroup
					value={view.diffRevision ?? ""}
					onValueChange={(diffRevision) => patch({ diffRevision })}
				>
					{[...book.data.revisions].reverse().map((revision) => (
						<DropdownMenuRadioItem key={revision.id} value={revision.id}>
							{book.revisionLabel(revision.id)}
							{revision.id === book.data.revisionId ? " · 最新提交" : ""}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
