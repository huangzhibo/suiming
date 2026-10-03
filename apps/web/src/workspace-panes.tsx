import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { type PaneTree, resizePanes, type WorkspaceLayout } from "./workspace-layout.js";

interface PaneProps {
	layout: WorkspaceLayout;
	setLayout: Dispatch<SetStateAction<WorkspaceLayout>>;
	renderGroup(id: string, first: boolean, last: boolean): ReactNode;
}
/** 窗口临时放不下布局时只展示活动窗格；放宽后恢复原分屏和比例。 */
export function WorkspacePanes({ layout, setLayout, renderGroup }: PaneProps) {
	const container = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: Infinity, height: Infinity });
	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const minimum = (tree: PaneTree): { width: number; height: number } => {
		if ("group" in tree) return { width: 280, height: 220 };
		const a = minimum(tree.first),
			b = minimum(tree.second);
		return tree.orientation === "horizontal"
			? { width: a.width + b.width + 1, height: Math.max(a.height, b.height) }
			: { width: Math.max(a.width, b.width), height: a.height + b.height + 1 };
	};
	const needed = minimum(layout.panes);
	const compact = layout.groups.length > 1 && (size.width < needed.width || size.height < needed.height);
	return (
		<div ref={container} className="flex h-full min-h-0 min-w-0 flex-col" data-compact-panes={compact}>
			<div className="min-h-0 min-w-0 flex-1">
				{compact ? (
					renderGroup(layout.activeGroup, true, true)
				) : (
					<SplitWorkspace tree={layout.panes} setLayout={setLayout} renderGroup={renderGroup} />
				)}
			</div>
			{compact && (
				<div className="flex shrink-0 items-center justify-end gap-1 border-t px-2 py-1 text-xs text-muted-foreground">
					<span className="mr-auto">窗口较小，暂时显示当前窗格</span>
					{layout.groups.map((group, index) => (
						<Button
							key={group.id}
							size="xs"
							variant={group.id === layout.activeGroup ? "secondary" : "ghost"}
							aria-label={`切换到窗格 ${index + 1}`}
							aria-pressed={group.id === layout.activeGroup}
							onClick={() => setLayout((v) => ({ ...v, activeGroup: group.id }))}
						>
							{index + 1}
						</Button>
					))}
				</div>
			)}
		</div>
	);
}
function SplitWorkspace({
	tree,
	first = true,
	last = true,
	setLayout,
	renderGroup,
}: Omit<PaneProps, "layout"> & { tree: PaneTree; first?: boolean; last?: boolean }) {
	if ("group" in tree) return renderGroup(tree.group, first, last);
	return (
		<ResizablePanelGroup
			key={tree.id}
			id={tree.id}
			orientation={tree.orientation}
			onLayoutChanged={(sizes, meta) => {
				if (meta.isUserInteraction)
					setLayout((current) => ({
						...current,
						panes: resizePanes(current.panes, tree.id, [sizes.first ?? 50, sizes.second ?? 50]),
					}));
			}}
		>
			<ResizablePanel id="first" defaultSize={`${tree.sizes[0]}%`} minSize="15%">
				<SplitWorkspace
					setLayout={setLayout}
					renderGroup={renderGroup}
					tree={tree.first}
					first={first}
					last={tree.orientation === "vertical" && last}
				/>
			</ResizablePanel>
			<ResizableHandle
				aria-label={tree.orientation === "horizontal" ? "调整分屏宽度" : "调整分屏高度"}
				className="no-drag"
			/>
			<ResizablePanel id="second" defaultSize={`${tree.sizes[1]}%`} minSize="15%">
				<SplitWorkspace
					setLayout={setLayout}
					renderGroup={renderGroup}
					tree={tree.second}
					first={tree.orientation === "vertical" && first}
					last={last}
				/>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
