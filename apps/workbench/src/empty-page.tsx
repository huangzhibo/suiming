import { BookOpen, File } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { documentTarget } from "./document-navigation.js";
import { type Book, filePage, KIND_LABEL, pageKind, pageTarget } from "./model.js";
import { OverflowHint } from "./ui-bits.js";
import type { OpenPage, PageState } from "./view-state.js";

export function EmptyPage({
	book,
	files,
	filesLoading,
	recent,
	searchState,
	onSearch,
	open,
}: {
	book: Book;
	files: string[];
	filesLoading: boolean;
	recent: string[];
	searchState: PageState["objectSearch"];
	onSearch(value: PageState["objectSearch"]): void;
	open: OpenPage;
}) {
	const { query, limit } = searchState;
	const search = query.trim().toLowerCase();
	const matches = search
		? [
				...book.data.files
					.filter((file) => file.kind !== "story-text")
					.map((file) => documentTarget(book, file.path).page),
				...files
					.filter((path) => !book.byPath.has(path) || book.byPath.get(path)?.kind === "story-text")
					.map(filePage),
			]
				.map((page) => {
					const title = book.pageTitle(page).toLowerCase();
					const path = (pageKind(page) === "file" ? pageTarget(page) : page).toLowerCase();
					if (title === search || path === search) return { page, rank: 0 };
					if (title.startsWith(search)) return { page, rank: 1 };
					if (title.includes(search)) return { page, rank: 2 };
					return { page, rank: path.includes(search) ? 3 : -1 };
				})
				.filter(({ rank }) => rank >= 0)
				.sort((a, b) => a.rank - b.rank)
				.map(({ page }) => page)
		: recent;
	const targets = search ? matches.slice(0, limit) : matches;
	return (
		<div className="mx-auto w-full max-w-[640px] overflow-auto px-8 py-6" data-scroll-key="empty">
			<h1 className="mb-2 text-xl font-semibold">打开一个工作页面</h1>
			<p className="mb-6 text-xs text-muted-foreground">搜索作品或文件，也可以从左栏开始浏览。</p>
			<Input
				aria-label="搜索对象或文件"
				placeholder="搜索标题或相对路径…"
				value={query}
				onChange={(event) => {
					onSearch({ query: event.target.value, limit: 60 });
					event.currentTarget.closest('[data-scroll-key="empty"]')?.scrollTo({ top: 0 });
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.nativeEvent.isComposing && search && targets[0]) {
						event.preventDefault();
						open(targets[0]);
					}
				}}
			/>
			<p className="mt-6 mb-2 text-xs text-muted-foreground" role="status">
				{search
					? filesLoading
						? "正在读取文件…"
						: !matches.length
							? "没有匹配项。"
							: targets.length < matches.length
								? `已显示 ${targets.length} / ${matches.length} 个匹配`
								: `${matches.length} 个匹配`
					: "最近访问"}
			</p>
			{targets.map((page) => {
				const kind = pageKind(page);
				const path = kind === "file" || kind === "diff" ? pageTarget(page) : page;
				const file = book.byPath.get(path);
				const title = book.pageTitle(page);
				const descriptions: Partial<Record<ReturnType<typeof pageKind>, string>> = {
					version: "版本比较",
					issue: "审稿意见",
					check: "确定性检查",
					spine: "全书结构",
					diff: `文件比较 · ${path}`,
				};
				const detail = file ? `${KIND_LABEL[file.kind] ?? "文件"} · ${path}` : (descriptions[kind] ?? path);
				const hint = path.split("/").at(-1) === `${title}.md` ? detail : `${title}\n${detail}`;
				return (
					<OverflowHint key={page} content={hint}>
						<button
							type="button"
							data-page={page}
							// tree-row 是 h-7 的单行树行；这里一行标题加一行路径约 36px，压不进 28px 就会互相叠上。
							// h-auto 把高度交还给内容（utilities 层压过 @layer components 的 @apply），其余交互样式照旧复用。
							className="tree-row h-auto gap-3 py-2 text-left"
							onClick={() => open(page)}
						>
							{pageKind(page) === "file" ? (
								<File className="size-4 shrink-0 text-muted-foreground" />
							) : (
								<BookOpen className="size-4 shrink-0 text-muted-foreground" />
							)}
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm">{title}</span>
								<span className="block truncate text-xs text-muted-foreground">{detail}</span>
							</span>
						</button>
					</OverflowHint>
				);
			})}
			{search && targets.length < matches.length && (
				<Button variant="outline" size="sm" className="mt-3" onClick={() => onSearch({ query, limit: limit + 60 })}>
					显示更多结果
				</Button>
			)}
			{!search && !targets.length && <p className="mt-4 text-xs text-muted-foreground">还没有访问记录。</p>}
		</div>
	);
}
