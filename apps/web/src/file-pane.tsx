import type { LocalCommandOutput } from "@suiming/sdk";
import { ChevronRight, ChevronsUpDown, File, Folder, LocateFixed, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { filePage } from "./model.js";
import { Hint, OverflowHint, PanelToolbar, ToolButton } from "./ui-bits.js";
import type { OpenPage, ViewState } from "./view-state.js";

type Entry = LocalCommandOutput<"workspace.files">["entries"][number];
export function FilePane({
	entries,
	view,
	patch,
	open,
	locate,
	loading,
	locatable,
}: {
	entries: Entry[];
	view: ViewState;
	patch(value: Partial<ViewState>): void;
	open: OpenPage;
	locate(): void;
	loading: boolean;
	locatable: boolean;
}) {
	const tree = useRef<HTMLDivElement>(null);
	const visible = useMemo(() => {
		const children = new Map<string, Entry[]>();
		for (const entry of entries) {
			const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
			children.set(parent, [...(children.get(parent) ?? []), entry]);
		}
		const result: Entry[] = [];
		const append = (parent: string) => {
			for (const entry of (children.get(parent) ?? []).sort(
				(a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.path.localeCompare(b.path),
			)) {
				result.push(entry);
				if (entry.type === "directory" && view.fileFolders[entry.path]) append(entry.path);
			}
		};
		append("");
		return result;
	}, [entries, view.fileFolders]);
	useEffect(() => {
		if (!view.fileSelection) return;
		tree.current?.querySelector<HTMLElement>(`[data-selected="true"]`)?.scrollIntoView({ block: "nearest" });
	}, [view.fileSelection]);
	const toggle = (path: string, on: boolean) => patch({ fileFolders: { ...view.fileFolders, [path]: on } });
	return (
		<>
			<PanelToolbar className="justify-center">
				<ToolButton
					label="定位当前文件"
					disabled={!locatable}
					disabledReason="当前页面没有对应的文件"
					onClick={locate}
				>
					<LocateFixed />
				</ToolButton>
				<ToolButton
					label="折叠所有文件夹"
					disabled={!Object.values(view.fileFolders).some(Boolean)}
					disabledReason="所有文件夹均已折叠"
					onClick={() => patch({ fileFolders: {} })}
				>
					<ChevronsUpDown />
				</ToolButton>
			</PanelToolbar>
			<div
				ref={tree}
				role="tree"
				aria-label="项目文件"
				data-side-scroll="files"
				className="min-h-0 flex-1 overflow-auto px-2 pb-2"
			>
				{loading && <p className="side-note">正在读取文件目录…</p>}
				{!loading && !entries.length && <p className="side-note">这个目录还没有文件。</p>}
				{visible.map((entry, index) => {
					const folder = entry.type === "directory";
					const selected = entry.path === view.fileSelection;
					const depth = entry.path.split("/").length;
					const EntryHint = depth > 1 || entry.diagnostic ? Hint : OverflowHint;
					return (
						<EntryHint
							side="right"
							content={`${entry.path}${entry.diagnostic ? `\n${entry.diagnostic}` : ""}`}
							key={entry.path}
						>
							<button
								type="button"
								role="treeitem"
								aria-level={depth}
								aria-expanded={folder ? !!view.fileFolders[entry.path] : undefined}
								aria-selected={selected}
								data-selected={selected}
								data-file-path={entry.path}
								data-page={!folder && entry.type !== "symlink" ? filePage(entry.path) : undefined}
								tabIndex={
									selected || (!visible.some((entry) => entry.path === view.fileSelection) && index === 0)
										? 0
										: -1
								}
								className="tree-row gap-1.5"
								data-on={selected}
								style={{ paddingLeft: `${8 + (depth - 1) * 14}px` }}
								onClick={() => {
									patch({ fileSelection: entry.path });
									if (folder) toggle(entry.path, !view.fileFolders[entry.path]);
									else if (entry.type !== "symlink") open(filePage(entry.path));
								}}
								onKeyDown={(event) => {
									const elements = [
										...(tree.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []),
									];
									if (event.key === "ArrowDown" || event.key === "ArrowUp") {
										event.preventDefault();
										elements[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
									}
									if (event.key === "Home" || event.key === "End") {
										event.preventDefault();
										elements[event.key === "Home" ? 0 : elements.length - 1]?.focus();
									}
									if (event.key === "ArrowRight" && folder) {
										event.preventDefault();
										if (!view.fileFolders[entry.path]) toggle(entry.path, true);
										else elements[index + 1]?.focus();
									}
									if (event.key === "ArrowLeft") {
										event.preventDefault();
										if (folder && view.fileFolders[entry.path]) toggle(entry.path, false);
										else
											elements
												.find(
													(element) =>
														element.dataset.filePath === entry.path.slice(0, entry.path.lastIndexOf("/")),
												)
												?.focus();
									}
								}}
							>
								{folder ? (
									<ChevronRight
										className={`size-3 shrink-0 ${view.fileFolders[entry.path] ? "rotate-90" : ""}`}
									/>
								) : (
									<span className="w-3 shrink-0" />
								)}
								{folder ? (
									<Folder className="size-3.5 shrink-0 text-muted-foreground" />
								) : (
									<File className="size-3.5 shrink-0 text-muted-foreground" />
								)}
								<span className="min-w-0 flex-1 truncate text-xs">{entry.path.split("/").at(-1)}</span>
								{entry.diagnostic && <TriangleAlert className="size-3 shrink-0 text-amber" />}
							</button>
						</EntryHint>
					);
				})}
			</div>
		</>
	);
}
