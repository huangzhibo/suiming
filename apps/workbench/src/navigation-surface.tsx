import { type MutableRefObject, type ReactNode, useState } from "react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { OpenOptions, OpenPage } from "./view-state.js";

/** 所有导航目标共用修饰键、中键和菜单；普通按钮及编辑器保留自己的交互。 */
export function NavigationSurface({
	children,
	open,
	gesture,
	className = "flex h-screen flex-col overflow-hidden bg-chrome",
}: {
	children: ReactNode;
	className?: string;
	open: OpenPage;
	gesture: MutableRefObject<OpenOptions>;
}) {
	const [target, setTarget] = useState("");
	const element = (node: EventTarget) => (node instanceof Element ? node.closest<HTMLElement>("[data-page]") : null);
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					data-navigation-surface
					className={className}
					onClickCapture={(event) => {
						if (
							event.target instanceof Element &&
							event.target.closest("[data-navigation-surface]") !== event.currentTarget
						)
							return;
						gesture.current = event.metaKey || event.ctrlKey ? { newTab: true, background: !event.shiftKey } : {};
						queueMicrotask(() => {
							gesture.current = {};
						});
					}}
					onAuxClickCapture={(event) => {
						if (
							event.target instanceof Element &&
							event.target.closest("[data-navigation-surface]") !== event.currentTarget
						)
							return;
						const page = element(event.target)?.dataset.page;
						if (event.button !== 1 || !page) return;
						event.preventDefault();
						event.stopPropagation();
						open(page, {}, { newTab: true, background: !event.shiftKey });
					}}
					onContextMenuCapture={(event) => {
						if (
							event.target instanceof Element &&
							event.target.closest("[data-navigation-surface]") !== event.currentTarget
						)
							return;
						if (event.target instanceof Element && event.target.closest("[data-tab-id]")) return;
						const page = element(event.target)?.dataset.page;
						if (page) setTarget(page);
						else event.stopPropagation();
					}}
				>
					{children}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuGroup>
					<ContextMenuItem onSelect={() => open(target, {}, { newTab: true })}>在新标签页打开</ContextMenuItem>
					<ContextMenuItem onSelect={() => open(target, {}, { newTab: true, background: true })}>
						在后台标签页打开
					</ContextMenuItem>
				</ContextMenuGroup>
			</ContextMenuContent>
		</ContextMenu>
	);
}
