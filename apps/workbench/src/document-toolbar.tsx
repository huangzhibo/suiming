import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, Ellipsis, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	type Book,
	type FileEntry,
	KIND_LABEL,
	pageKind,
	pageTarget,
	type ReviewReport,
	textPathFor,
	versionPage,
} from "./model.js";
import { Hint, OverflowHint, PanelToolbar, Segmented, ToolButton } from "./ui-bits.js";
import type { BeatView, OpenPage, ViewState } from "./view-state.js";

export function DocumentToolbar({
	book,
	view,
	file,
	reports,
	patch,
	open,
	go,
	locate,
	edit,
	diff,
	finish,
	editable,
	copy,
	system,
	split,
	merge,
	selectContent,
	comparisonActions,
	comparisonOptions,
}: {
	comparisonActions?: ReactNode;
	comparisonOptions?: ReactNode;
	book: Book;
	view: ViewState;
	file: FileEntry | undefined;
	reports: ReviewReport[];
	patch(value: Partial<ViewState>): void;
	open: OpenPage;
	go(direction: "back" | "forward"): void;
	locate(path: string, side?: "files" | "spine" | "ids" | "sources"): void;
	edit(path: string): void;
	diff(path: string): void;
	finish(): void;
	editable: boolean;
	copy(path: string): void;
	system(path: string): void;
	split(orientation: "horizontal" | "vertical", paired?: boolean): void;
	merge: (() => void) | undefined;
	selectContent(view: BeatView): void;
}) {
	const kind = pageKind(view.page);
	const raw = kind === "file" || kind === "diff" ? pageTarget(view.page) : file?.path;
	const beat = kind === "artifact" && file?.kind === "story-beat" && file.namespace === "target";
	const textPath = beat && file ? textPathFor(file.localId) : "";
	const current =
		view.edit !== "read" && view.targetPath ? view.targetPath : beat && view.beatView === "text" ? textPath : raw;
	const history = view.tabs[view.active];
	const breadcrumbs: { label: string; action?: () => void }[] = [];
	if (kind === "file" && raw) {
		const parts = raw.split("/");
		parts.forEach((part, index) => {
			breadcrumbs.push({
				label: part,
				...(index < parts.length - 1 ? { action: () => locate(parts.slice(0, index + 1).join("/")) } : {}),
			});
		});
	} else if ((kind === "artifact" || kind === "diff") && file) {
		const volume = book.volumeOf(file.localId);
		const category = ["story-beat", "story-text"].includes(file.kind)
			? volume?.title
			: (KIND_LABEL[file.kind] ?? "材料");
		const side = ["story-beat", "story-text", "story-index"].includes(file.kind)
			? "spine"
			: ["character", "place", "resource", "story-contract", "world"].includes(file.kind)
				? "ids"
				: "sources";
		if (category) breadcrumbs.push({ label: category, action: () => locate(file.path, side) });
		breadcrumbs.push({ label: kind === "diff" ? book.pageTitle(view.page, reports) : book.title(file) });
	} else if (kind === "spine") {
		breadcrumbs.push({
			label: "故事轴",
			...(view.axisVolume ? { action: () => patch({ axisVolume: null, axisColumn: null }) } : {}),
		});
		if (view.axisVolume)
			breadcrumbs.push({ label: book.data.volumes.find((v) => v.id === view.axisVolume)?.title ?? view.axisVolume });
	} else if (kind !== "empty") breadcrumbs.push({ label: book.pageTitle(view.page, reports) });
	const fullPath = breadcrumbs.map((item) => item.label).join(" / ");
	const displayed =
		breadcrumbs.length > 3
			? [breadcrumbs[0], { label: "…", action: breadcrumbs.at(-2)?.action }, breadcrumbs.at(-1)].filter(
					(item): item is NonNullable<typeof item> => !!item,
				)
			: breadcrumbs;
	const options: { id: BeatView; label: string }[] = [
		{ id: "design", label: "设计" },
		{ id: "text", label: "正文" },
	];
	const toggle = () => {
		if (view.edit === "read" && current) edit(current);
		else finish();
	};
	const fileAvailable = kind === "file" || !!(current && book.byPath.has(current));
	// 菜单项禁用时直接写出原因：窄窗口里没有悬停提示。典型是情节还没有正文时切到了正文视图。
	const missing = fileAvailable ? "" : "（文件还不存在）";
	return (
		<PanelToolbar
			className="document-toolbar grid gap-1 text-xs text-muted-foreground"
			aria-label="文档工具"
			data-content-switch={beat}
			data-comparison={kind === "diff"}
		>
			<div className="flex min-w-0 items-center gap-1">
				<ToolButton
					label="后退"
					disabledReason="当前标签页没有可返回的位置"
					disabled={!history?.back.length}
					onClick={() => go("back")}
				>
					<ChevronLeft />
				</ToolButton>
				<ToolButton
					label="前进"
					disabledReason="当前标签页没有可前进的位置"
					disabled={!history?.forward.length}
					onClick={() => go("forward")}
				>
					<ChevronRight />
				</ToolButton>
			</div>
			<nav
				aria-label={kind === "file" ? "文件路径" : "作品位置"}
				className="flex min-w-0 items-center justify-center"
			>
				{displayed.map((item, index) => {
					const omitted = breadcrumbs.length > 3 && index === 1;
					const NameHint = omitted ? Hint : OverflowHint;
					return (
						<span
							key={displayed
								.slice(0, index + 1)
								.map((item) => item.label)
								.join("/")}
							className={`flex min-w-0 items-center ${index === displayed.length - 1 ? `text-foreground ${displayed.length > 1 ? "max-w-[75%] shrink-0" : ""}` : ""}`}
						>
							{index > 0 && (
								<span aria-hidden className="shrink-0 px-1 text-muted-foreground">
									/
								</span>
							)}
							<NameHint content={omitted ? fullPath : item.label}>
								{item.action ? (
									<button
										type="button"
										className="navigation-link truncate"
										aria-label={omitted ? "定位折叠的路径" : undefined}
										onClick={item.action}
									>
										{item.label}
									</button>
								) : (
									<span
										className="truncate px-1.5 py-1"
										aria-current={index === displayed.length - 1 ? "page" : undefined}
									>
										{item.label}
									</span>
								)}
							</NameHint>
						</span>
					);
				})}
			</nav>
			<div className="flex min-w-0 items-center justify-end gap-1">
				{kind === "diff" ? (
					comparisonActions
				) : (
					<>
						{beat && (
							<>
								<Segmented
									className="document-view-segments"
									value={view.beatView}
									options={options}
									onChange={selectContent}
								/>
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												className="document-view-menu"
												variant="secondary"
												size="xs"
												aria-label="内容视图"
											>
												{view.beatView === "design" ? "设计" : "正文"}
												<ChevronDown data-icon="inline-end" />
											</Button>
										}
									/>
									<DropdownMenuContent align="end">
										<DropdownMenuRadioGroup
											value={view.beatView}
											onValueChange={(value) => selectContent(value as BeatView)}
										>
											{options.map((option) => (
												<DropdownMenuRadioItem key={option.id} value={option.id}>
													{option.label}
												</DropdownMenuRadioItem>
											))}
										</DropdownMenuRadioGroup>
									</DropdownMenuContent>
								</DropdownMenu>
							</>
						)}
						{current && editable && (
							<ToolButton
								label={view.edit === "read" ? "切换到编辑视图" : "切换到阅读视图"}
								description="⌘/Ctrl E"
								onClick={toggle}
							>
								{view.edit === "read" ? <Pencil /> : <BookOpen />}
							</ToolButton>
						)}
					</>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<ToolButton label="更多" description="视图、分屏、版本与文件操作">
								<Ellipsis />
							</ToolButton>
						}
					/>
					<DropdownMenuContent align="end" className="min-w-52">
						{kind !== "diff" && current && editable && (
							<>
								<DropdownMenuRadioGroup
									value={view.edit}
									onValueChange={(value) => {
										if (value === "read") patch({ edit: "read", targetPath: "" });
										else edit(current);
									}}
								>
									<DropdownMenuRadioItem value="read">阅读视图</DropdownMenuRadioItem>
									<DropdownMenuRadioItem value="edit">编辑视图</DropdownMenuRadioItem>
								</DropdownMenuRadioGroup>
								<DropdownMenuSeparator />
							</>
						)}
						{comparisonOptions}
						<DropdownMenuGroup>
							{beat && (
								<DropdownMenuItem onClick={() => split("horizontal", true)}>
									并排查看设计与正文
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onClick={() => split("horizontal")}>左右分屏</DropdownMenuItem>
							<DropdownMenuItem onClick={() => split("vertical")}>上下分屏</DropdownMenuItem>
							{merge && <DropdownMenuItem onClick={merge}>合并到相邻窗格</DropdownMenuItem>}
						</DropdownMenuGroup>
						{file && current && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									{kind !== "diff" && (
										<DropdownMenuItem onClick={() => diff(current)}>查看版本差异</DropdownMenuItem>
									)}
									<DropdownMenuItem
										disabled={!fileAvailable}
										onClick={() => open(versionPage(book.data.revisionId), { versionFile: current })}
									>
										查看版本记录{missing}
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</>
						)}
						{current && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuGroup>
									<DropdownMenuItem disabled={!fileAvailable} onClick={() => locate(current)}>
										在文件树中定位{missing}
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => copy(current)}>复制相对路径</DropdownMenuItem>
									<DropdownMenuItem disabled={!fileAvailable} onClick={() => system(current)}>
										在 Finder 中显示{missing}
									</DropdownMenuItem>
								</DropdownMenuGroup>
							</>
						)}
						{current && !fileAvailable && (
							<p className="px-2 py-1 text-xs text-muted-foreground">正文尚未保存，暂不能定位文件。</p>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</PanelToolbar>
	);
}
